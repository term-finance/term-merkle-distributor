// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity =0.8.17;

import {MerkleDistributor} from "../contracts/MerkleDistributor.sol";
import {MerkleDistributorWithDeadline} from "../contracts/MerkleDistributorWithDeadline.sol";

interface Vm {
    function assume(bool condition) external pure;
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
}

/// @dev Records every transfer, so a proof can check exactly what a claim paid. Transfers always
///      succeed, as from a fully funded distributor: the claim proofs are about bookkeeping.
contract TokenStub {
    address public lastTo;
    uint256 public lastAmount;
    uint256 public transfers;

    function transfer(address to, uint256 amount) external returns (bool) {
        lastTo = to;
        lastAmount = amount;
        transfers++;
        return true;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }
}

/// @dev A token that keeps balances, for the withdrawal proofs, which are about how much moves.
contract BalanceTokenStub {
    mapping(address => uint256) public balanceOf;
    uint256 public transfers;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        transfers++;
        return true;
    }
}

/// @title Claim properties of the Merkle distributors, proved for every input
/// @notice Each proof builds a one-leaf tree from symbolic inputs: the root is the
///         leaf and the proof is empty. That makes the claim valid by construction,
///         so a pass is about the distributor's bookkeeping for every index,
///         account and amount, not about a hand-picked tree.
contract MerkleDistributorProofs {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32[] internal noProof;

    function _leaf(uint256 index, address account, uint256 amount) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(index, account, amount));
    }

    function _deploy(uint256 index, address account, uint256 amount)
        internal
        returns (MerkleDistributor distributor, TokenStub token)
    {
        token = new TokenStub();
        distributor = new MerkleDistributor(address(token), _leaf(index, account, amount));
    }

    /// @notice A leaf pays out once, to its account, for its amount -- and never again.
    function check_aLeafPaysExactlyOnce(uint256 index, address account, uint256 amount) public {
        (MerkleDistributor distributor, TokenStub token) = _deploy(index, account, amount);

        distributor.claim(index, account, amount, noProof);
        assert(distributor.isClaimed(index));
        assert(token.transfers() == 1);
        assert(token.lastTo() == account);
        assert(token.lastAmount() == amount);

        try distributor.claim(index, account, amount, noProof) {
            assert(false);
        } catch {}
        assert(token.transfers() == 1);
    }

    /// @notice Claiming one index never marks another as claimed. The claimed set is
    ///         a packed bitmap, so this is the property an off-by-one would break.
    function check_claimingOneIndexClaimsNoOther(uint256 index, uint256 other, address account, uint256 amount) public {
        vm.assume(other != index);
        (MerkleDistributor distributor, ) = _deploy(index, account, amount);
        distributor.claim(index, account, amount, noProof);
        assert(!distributor.isClaimed(other));
    }

    /// @notice Nothing is claimed before the first claim.
    function check_nothingStartsClaimed(uint256 index, uint256 other, address account, uint256 amount) public {
        (MerkleDistributor distributor, ) = _deploy(index, account, amount);
        assert(!distributor.isClaimed(other));
    }

    /// @notice A claim cannot redirect a leaf to another account or inflate its amount.
    function check_aClaimCannotRedirectOrInflate(
        uint256 index,
        address account,
        uint256 amount,
        address to,
        uint256 asked
    ) public {
        vm.assume(to != account || asked != amount);
        (MerkleDistributor distributor, TokenStub token) = _deploy(index, account, amount);
        try distributor.claim(index, to, asked, noProof) {
            assert(false);
        } catch {}
        assert(token.transfers() == 0);
        assert(!distributor.isClaimed(index));
    }

    function _deployWithDeadline(uint256 index, address account, uint256 amount, uint256 endTime)
        internal
        returns (MerkleDistributorWithDeadline distributor, TokenStub token)
    {
        token = new TokenStub();
        distributor = new MerkleDistributorWithDeadline(address(token), _leaf(index, account, amount), endTime);
    }

    /// @notice No claim succeeds after the deadline.
    function check_noClaimAfterTheDeadline(uint256 endTime, uint256 later, uint256 index, address account, uint256 amount) public {
        vm.assume(endTime > block.timestamp && later > endTime);
        (MerkleDistributorWithDeadline distributor, TokenStub token) = _deployWithDeadline(index, account, amount, endTime);
        vm.warp(later);
        try distributor.claim(index, account, amount, noProof) {
            assert(false);
        } catch {}
        assert(token.transfers() == 0);
    }

    /// @notice A valid claim still pays inside the window, so the deadline proof above
    ///         is not passing merely because every claim reverts.
    function check_aClaimInsideTheWindowPays(uint256 endTime, uint256 at, uint256 index, address account, uint256 amount) public {
        vm.assume(endTime > block.timestamp && at <= endTime);
        (MerkleDistributorWithDeadline distributor, TokenStub token) = _deployWithDeadline(index, account, amount, endTime);
        vm.warp(at);
        distributor.claim(index, account, amount, noProof);
        assert(token.transfers() == 1 && token.lastTo() == account && token.lastAmount() == amount);
    }

    function _deployFunded(uint256 endTime, uint256 funded)
        internal
        returns (MerkleDistributorWithDeadline distributor, BalanceTokenStub token)
    {
        token = new BalanceTokenStub();
        distributor = new MerkleDistributorWithDeadline(address(token), _leaf(0, address(1), 1), endTime);
        token.mint(address(distributor), funded);
    }

    /// @notice Only the owner can withdraw the remainder.
    function check_onlyOwnerWithdraws(uint256 endTime, uint256 later, address caller, uint256 funded) public {
        vm.assume(endTime > block.timestamp && later >= endTime && caller != address(this));
        (MerkleDistributorWithDeadline distributor, BalanceTokenStub token) = _deployFunded(endTime, funded);
        vm.warp(later);
        vm.prank(caller);
        try distributor.withdraw() {
            assert(false);
        } catch {}
        assert(token.transfers() == 0);
        assert(token.balanceOf(address(distributor)) == funded);
    }

    /// @notice Not even the owner can withdraw before the deadline. At the deadline itself the
    ///         owner can, while claims still pay: see the finding below.
    function check_noWithdrawBeforeTheDeadline(uint256 endTime, uint256 at, uint256 funded) public {
        vm.assume(endTime > block.timestamp && at < endTime);
        (MerkleDistributorWithDeadline distributor, BalanceTokenStub token) = _deployFunded(endTime, funded);
        vm.warp(at);
        try distributor.withdraw() {
            assert(false);
        } catch {}
        assert(token.transfers() == 0);
        assert(token.balanceOf(address(distributor)) == funded);
    }

    function _deployFundedFor(uint256 endTime, uint256 index, address account, uint256 amount)
        internal
        returns (MerkleDistributorWithDeadline distributor, BalanceTokenStub token)
    {
        token = new BalanceTokenStub();
        distributor = new MerkleDistributorWithDeadline(address(token), _leaf(index, account, amount), endTime);
        token.mint(address(distributor), amount);
    }

    /// @notice FINDING: the deadline second belongs to both windows. At `block.timestamp == endTime`,
    ///         `claim` still pays (it refuses only after endTime) and `withdraw` already succeeds (it
    ///         refuses only before endTime). The owner can therefore sweep the remainder in the same
    ///         block as claims that are still valid, which then fail for want of tokens. Shown on two
    ///         identically funded distributors at the same second, so neither result depends on the
    ///         other having run first.
    function check_FINDING_ownerCanSweepWhileClaimsStillPay(uint256 endTime, uint256 index, address account, uint256 amount)
        public
    {
        vm.assume(endTime > block.timestamp && amount > 0 && account != address(this));
        (MerkleDistributorWithDeadline claimable, BalanceTokenStub claimToken) = _deployFundedFor(endTime, index, account, amount);
        (MerkleDistributorWithDeadline sweepable, BalanceTokenStub sweepToken) = _deployFundedFor(endTime, index, account, amount);
        vm.warp(endTime);

        // A valid claim still pays at this second...
        (bool claimed, ) =
            address(claimable).call(abi.encodeCall(MerkleDistributorWithDeadline.claim, (index, account, amount, noProof)));
        assert(claimed && claimable.isClaimed(index));

        // ...and the owner can already take everything that claim is paid from.
        (bool swept, ) = address(sweepable).call(abi.encodeCall(MerkleDistributorWithDeadline.withdraw, ()));
        assert(swept && sweepToken.balanceOf(address(sweepable)) == 0 && sweepToken.balanceOf(address(this)) == amount);
        claimToken;
    }

    /// @notice After the deadline, the owner withdraws the whole remainder, whatever it is. The deadline
    ///         second itself is the finding above.
    function check_ownerWithdrawsTheRemainderAfterTheDeadline(uint256 endTime, uint256 later, uint256 funded) public {
        vm.assume(endTime > block.timestamp && later > endTime);
        (MerkleDistributorWithDeadline distributor, BalanceTokenStub token) = _deployFunded(endTime, funded);
        vm.warp(later);
        distributor.withdraw();
        assert(token.transfers() == 1);
        assert(token.balanceOf(address(distributor)) == 0);
        assert(token.balanceOf(address(this)) == funded);
    }
}
