import { expect } from 'chai'
import { Contract, getAddress, MaxUint256, Signer } from 'ethers'
import hre from 'hardhat'
import BalanceTree from '../src/balance-tree'
import { parseBalanceMap } from '../src/parse-balance-map'
import '@nomicfoundation/hardhat-ethers'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import {
  MerkleDistributor,
  MerkleDistributor__factory,
  MerkleDistributorWithDeadline,
  MerkleDistributorWithDeadline__factory,
  TestERC20,
} from '../typechain-types'
import { NonPayableOverrides } from '../typechain-types/common'

const overrides = {
  gasLimit: 9999999n,
} as NonPayableOverrides & {
  from?: string
}
const gasUsed = {
  MerkleDistributor: {
    twoAccountTree: 81970,
    largerTreeFirstClaim: 85307,
    largerTreeSecondClaim: 68207,
    realisticTreeGas: 95256,
    realisticTreeGasDeeperNode: 95172,
    realisticTreeGasAverageRandom: 78598,
    realisticTreeGasAverageFirst25: 62332,
  },
  MerkleDistributorWithDeadline: {
    twoAccountTree: 82102,
    largerTreeFirstClaim: 85439,
    largerTreeSecondClaim: 68339,
    realisticTreeGas: 95388,
    realisticTreeGasDeeperNode: 95304,
    realisticTreeGasAverageRandom: 78730,
    realisticTreeGasAverageFirst25: 62464,
  },
}

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000'

const deployContract = async (
  factory: MerkleDistributor__factory | MerkleDistributorWithDeadline__factory,
  tokenAddress: string,
  merkleRoot: string,
  contract: string,
) => {
  let distributor: MerkleDistributor | MerkleDistributorWithDeadline
  const currentTimestamp = Math.floor(Date.now() / 1000)
  if (contract === 'MerkleDistributorWithDeadline') {
    distributor = await (factory as MerkleDistributorWithDeadline__factory).deploy(
      tokenAddress,
      merkleRoot,
      currentTimestamp + 31536000,
      overrides,
    )
  } else {
    distributor = await (factory as MerkleDistributor__factory).deploy(tokenAddress, merkleRoot, overrides)
  }
  return distributor
}

for (const contract of ['MerkleDistributor', 'MerkleDistributorWithDeadline'] as [
  'MerkleDistributor',
  'MerkleDistributorWithDeadline',
]) {
  describe(`${contract} tests`, () => {
    let token: TestERC20
    let distributorFactory: MerkleDistributor__factory | MerkleDistributorWithDeadline__factory
    let wallet0: SignerWithAddress
    let wallet1: SignerWithAddress
    let wallets: SignerWithAddress[]

    beforeEach(async () => {
      wallets = await hre.ethers.getSigners()
      wallet0 = wallets[0]
      wallet1 = wallets[1]
      const tokenFactory = await hre.ethers.getContractFactory('TestERC20', wallet0 as unknown as Signer)
      token = await tokenFactory.deploy('Token', 'TKN', 0, overrides)
      distributorFactory = (await hre.ethers.getContractFactory(contract, wallet0 as unknown as Signer)) as
        | MerkleDistributor__factory
        | MerkleDistributorWithDeadline__factory
    })

    describe('#token', () => {
      it('returns the token address', async () => {
        const distributor = await deployContract(distributorFactory, await token.getAddress(), ZERO_BYTES32, contract)
        expect(await distributor.token()).to.eq(await token.getAddress())
      })
    })

    describe('#merkleRoot', () => {
      it('returns the zero merkle root', async () => {
        const distributor = await deployContract(distributorFactory, await token.getAddress(), ZERO_BYTES32, contract)
        expect(await distributor.merkleRoot()).to.eq(ZERO_BYTES32)
      })
    })

    describe('#claim', () => {
      it('fails for empty proof', async () => {
        const distributor = await deployContract(distributorFactory, await token.getAddress(), ZERO_BYTES32, contract)
        await expect(distributor.claim(0, wallet0.address, 10, [])).to.be.revertedWithCustomError(
          distributor,
          'InvalidProof',
        )
      })

      it('fails for invalid index', async () => {
        const distributor = await deployContract(distributorFactory, await token.getAddress(), ZERO_BYTES32, contract)
        await expect(distributor.claim(0, wallet0.address, 10, [])).to.be.revertedWithCustomError(
          distributor,
          'InvalidProof',
        )
      })

      describe('two account tree', () => {
        let distributor: MerkleDistributor | MerkleDistributorWithDeadline
        let tree: BalanceTree
        beforeEach('deploy', async () => {
          tree = new BalanceTree([
            { account: wallet0.address, amount: 100n },
            { account: wallet1.address, amount: 101n },
          ])
          distributor = await deployContract(distributorFactory, await token.getAddress(), tree.getHexRoot(), contract)
          await token.setBalance(await distributor.getAddress(), 201)
        })

        it('successful claim', async () => {
          const proof0 = tree.getProof(0, wallet0.address, 100n)
          await expect(distributor.claim(0, wallet0.address, 100, proof0, overrides))
            .to.emit(distributor, 'Claimed')
            .withArgs(0, wallet0.address, 100)
          const proof1 = tree.getProof(1, wallet1.address, 101n)
          await expect(distributor.claim(1, wallet1.address, 101, proof1, overrides))
            .to.emit(distributor, 'Claimed')
            .withArgs(1, wallet1.address, 101)
        })

        it('transfers the token', async () => {
          const proof0 = tree.getProof(0, wallet0.address, 100n)
          expect(await token.balanceOf(wallet0.address)).to.eq(0)
          await distributor.claim(0, wallet0.address, 100, proof0, overrides)
          expect(await token.balanceOf(wallet0.address)).to.eq(100)
        })

        it('must have enough to transfer', async () => {
          const proof0 = tree.getProof(0, wallet0.address, 100n)
          await token.setBalance(await distributor.getAddress(), 99)
          await expect(distributor.claim(0, wallet0.address, 100, proof0, overrides)).to.be.revertedWith(
            'ERC20: transfer amount exceeds balance',
          )
        })

        it('sets #isClaimed', async () => {
          const proof0 = tree.getProof(0, wallet0.address, 100n)
          expect(await distributor.isClaimed(0)).to.eq(false)
          expect(await distributor.isClaimed(1)).to.eq(false)
          await distributor.claim(0, wallet0.address, 100, proof0, overrides)
          expect(await distributor.isClaimed(0)).to.eq(true)
          expect(await distributor.isClaimed(1)).to.eq(false)
        })

        it('cannot allow two claims', async () => {
          const proof0 = tree.getProof(0, wallet0.address, 100n)
          await distributor.claim(0, wallet0.address, 100, proof0, overrides)
          await expect(distributor.claim(0, wallet0.address, 100, proof0, overrides)).to.be.revertedWithCustomError(
            distributor,
            'AlreadyClaimed',
          )
        })

        it('cannot claim more than once: 0 and then 1', async () => {
          await distributor.claim(0, wallet0.address, 100, tree.getProof(0, wallet0.address, 100n), overrides)
          await distributor.claim(1, wallet1.address, 101, tree.getProof(1, wallet1.address, 101n), overrides)

          await expect(
            distributor.claim(0, wallet0.address, 100, tree.getProof(0, wallet0.address, 100n), overrides),
          ).to.be.revertedWithCustomError(distributor, 'AlreadyClaimed')
        })

        it('cannot claim more than once: 1 and then 0', async () => {
          await distributor.claim(1, wallet1.address, 101, tree.getProof(1, wallet1.address, 101n), overrides)
          await distributor.claim(0, wallet0.address, 100, tree.getProof(0, wallet0.address, 100n), overrides)

          await expect(
            distributor.claim(1, wallet1.address, 101, tree.getProof(1, wallet1.address, 101n), overrides),
          ).to.be.revertedWithCustomError(distributor, 'AlreadyClaimed')
        })

        it('cannot claim for address other than proof', async () => {
          const proof0 = tree.getProof(0, wallet0.address, 100n)
          await expect(distributor.claim(1, wallet1.address, 101, proof0, overrides)).to.be.revertedWithCustomError(
            distributor,
            'InvalidProof',
          )
        })

        it('cannot claim more than proof', async () => {
          const proof0 = tree.getProof(0, wallet0.address, 100n)
          await expect(distributor.claim(0, wallet0.address, 101, proof0, overrides)).to.be.revertedWithCustomError(
            distributor,
            'InvalidProof',
          )
        })

        it('gas', async () => {
          const proof = tree.getProof(0, wallet0.address, 100n)
          const tx = await distributor.claim(0, wallet0.address, 100, proof, overrides)
          const receipt = await tx.wait()
          expect(receipt?.gasUsed).to.eq(gasUsed[contract as keyof typeof gasUsed].twoAccountTree)
        })
      })

      describe('larger tree', () => {
        let distributor: MerkleDistributor | MerkleDistributorWithDeadline
        let tree: BalanceTree
        beforeEach('deploy', async () => {
          tree = new BalanceTree(
            wallets.map((wallet, ix) => {
              return { account: wallet.address, amount: BigInt(ix + 1) }
            }),
          )
          distributor = await deployContract(distributorFactory, await token.getAddress(), tree.getHexRoot(), contract)
          await token.setBalance(await distributor.getAddress(), 201)
        })

        it('claim index 4', async () => {
          const proof = tree.getProof(4, wallets[4].address, 5n)
          await expect(distributor.claim(4, wallets[4].address, 5, proof, overrides))
            .to.emit(distributor, 'Claimed')
            .withArgs(4, wallets[4].address, 5)
        })

        it('claim index 9', async () => {
          const proof = tree.getProof(9, wallets[9].address, 10n)
          await expect(distributor.claim(9, wallets[9].address, 10, proof, overrides))
            .to.emit(distributor, 'Claimed')
            .withArgs(9, wallets[9].address, 10)
        })

        it('gas', async () => {
          const proof = tree.getProof(9, wallets[9].address, 10n)
          const tx = await distributor.claim(9, wallets[9].address, 10, proof, overrides)
          const receipt = await tx.wait()
          expect(receipt?.gasUsed).to.eq(gasUsed[contract as keyof typeof gasUsed].largerTreeFirstClaim)
        })

        it('gas second down about 15k', async () => {
          await distributor.claim(0, wallets[0].address, 1, tree.getProof(0, wallets[0].address, 1n), overrides)
          const tx = await distributor.claim(
            1,
            wallets[1].address,
            2,
            tree.getProof(1, wallets[1].address, 2n),
            overrides,
          )
          const receipt = await tx.wait()
          expect(receipt?.gasUsed).to.eq(gasUsed[contract as keyof typeof gasUsed].largerTreeSecondClaim)
        })
      })

      describe('realistic size tree', () => {
        let distributor: MerkleDistributor | MerkleDistributorWithDeadline
        let tree: BalanceTree
        const NUM_LEAVES = 100_000
        const NUM_SAMPLES = 25

        beforeEach('deploy', async () => {
          const elements: { account: string; amount: bigint }[] = []
          for (let i = 0; i < NUM_LEAVES; i++) {
            const node = { account: wallet0.address, amount: 100n }
            elements.push(node)
          }
          tree = new BalanceTree(elements)
          distributor = await deployContract(distributorFactory, await token.getAddress(), tree.getHexRoot(), contract)
          await token.setBalance(await distributor.getAddress(), MaxUint256)
        })

        it('proof verification works', () => {
          const root = Buffer.from(tree.getHexRoot().slice(2), 'hex')
          for (let i = 0; i < NUM_LEAVES; i += NUM_LEAVES / NUM_SAMPLES) {
            const proof = tree.getProof(i, wallet0.address, 100n).map((el) => Buffer.from(el.slice(2), 'hex'))
            const validProof = BalanceTree.verifyProof(i, wallet0.address, 100n, proof, root)
            expect(validProof).to.be.true
          }
        })

        it('gas', async () => {
          const proof = tree.getProof(50000, wallet0.address, 100n)
          const tx = await distributor.claim(50000, wallet0.address, 100, proof, overrides)
          const receipt = await tx.wait()
          expect(receipt?.gasUsed).to.eq(gasUsed[contract as keyof typeof gasUsed].realisticTreeGas)
        })
        it('gas deeper node', async () => {
          const proof = tree.getProof(90000, wallet0.address, 100n)
          const tx = await distributor.claim(90000, wallet0.address, 100, proof, overrides)
          const receipt = await tx.wait()
          expect(receipt?.gasUsed).to.eq(gasUsed[contract as keyof typeof gasUsed].realisticTreeGasDeeperNode)
        })
        it('gas average random distribution', async () => {
          let total = 0n
          let count = 0n
          for (let i = 0; i < NUM_LEAVES; i += NUM_LEAVES / NUM_SAMPLES) {
            const proof = tree.getProof(i, wallet0.address, 100n)
            const tx = await distributor.claim(i, wallet0.address, 100, proof, overrides)
            const receipt = await tx.wait()
            total = total + (receipt?.gasUsed ?? 0n)
            count++
          }
          const average = Number(total / count)
          expect(average).to.eq(gasUsed[contract as keyof typeof gasUsed].realisticTreeGasAverageRandom)
        })
        // this is what we gas golfed by packing the bitmap
        it('gas average first 25', async () => {
          let total = 0n
          let count = 0n
          for (let i = 0; i < 25; i++) {
            const proof = tree.getProof(i, wallet0.address, 100n)
            const tx = await distributor.claim(i, wallet0.address, 100, proof, overrides)
            const receipt = await tx.wait()
            total = total + (receipt?.gasUsed ?? 0n)
            count++
          }
          const average = Number(total / count)
          expect(average).to.eq(gasUsed[contract as keyof typeof gasUsed].realisticTreeGasAverageFirst25)
        })

        it('no double claims in random distribution', async () => {
          for (let i = 0; i < 25; i += Math.floor(Math.random() * (NUM_LEAVES / NUM_SAMPLES))) {
            const proof = tree.getProof(i, wallet0.address, 100n)
            await distributor.claim(i, wallet0.address, 100, proof, overrides)
            await expect(distributor.claim(i, wallet0.address, 100, proof, overrides)).to.be.revertedWithCustomError(
              distributor,
              'AlreadyClaimed',
            )
          }
        })
      })

      describe('parseBalanceMap', () => {
        let distributor: MerkleDistributor | MerkleDistributorWithDeadline
        let claims: {
          [account: string]: {
            index: number
            amount: string
            proof: string[]
          }
        }
        beforeEach('deploy', async () => {
          const {
            claims: innerClaims,
            merkleRoot,
            tokenTotal,
          } = parseBalanceMap({
            [wallet0.address]: 200,
            [wallet1.address]: 300,
            [wallets[2].address]: 250,
          })
          expect(tokenTotal).to.eq('0x02ee') // 750
          claims = innerClaims
          distributor = await deployContract(distributorFactory, await token.getAddress(), merkleRoot, contract)
          await token.setBalance(await distributor.getAddress(), tokenTotal)
        })

        it('check the proofs is as expected', () => {
          expect(claims).to.deep.eq({
            [wallet0.address.toLowerCase()]: {
              index: 2,
              amount: '0xc8',
              proof: [
                '0x0782528e118c4350a2465fbeabec5e72fff06991a29f21c08d37a0d275e38ddd',
                '0xf3c5acb53398e1d11dcaa74e37acc33d228f5da944fbdea9a918684074a21cdb',
              ],
            },
            [wallet1.address.toLowerCase()]: {
              index: 1,
              amount: '0x012c',
              proof: [
                '0xc86fd316fa3e7b83c2665b5ccb63771e78abcc0429e0105c91dde37cb9b857a4',
                '0xf3c5acb53398e1d11dcaa74e37acc33d228f5da944fbdea9a918684074a21cdb',
              ],
            },
            [wallets[2].address.toLowerCase()]: {
              index: 0,
              amount: '0xfa',
              proof: ['0x0c9bcaca2a1013557ef7f348b514ab8a8cd6c7051b69e46b1681a2aff22f4a88'],
            },
          })
        })

        it('all claims work exactly once', async () => {
          for (let account in claims) {
            const claim = claims[account]
            await expect(distributor.claim(claim.index, account, claim.amount, claim.proof, overrides))
              .to.emit(distributor, 'Claimed')
              .withArgs(claim.index, getAddress(account), claim.amount)
            await expect(
              distributor.claim(claim.index, account, claim.amount, claim.proof, overrides),
            ).to.be.revertedWithCustomError(distributor, 'AlreadyClaimed')
          }
          expect(await token.balanceOf(await distributor.getAddress())).to.eq(0)
        })
      })
    })
  })
}

describe('#MerkleDistributorWithDeadline', () => {
  let token: TestERC20
  let wallet0: SignerWithAddress
  let wallet1: SignerWithAddress
  let wallets: SignerWithAddress[]
  let distributor: MerkleDistributorWithDeadline
  let tree: BalanceTree
  let currentTimestamp = Math.floor(Date.now() / 1000)

  beforeEach('deploy', async () => {
    wallets = await hre.ethers.getSigners()
    wallet0 = wallets[0]
    wallet1 = wallets[1]
    const tokenFactory = await hre.ethers.getContractFactory('TestERC20', wallet0 as unknown as Signer)
    token = await tokenFactory.deploy('Token', 'TKN', 0, overrides)
    tree = new BalanceTree([
      { account: wallet0.address, amount: 100n },
      { account: wallet1.address, amount: 101n },
    ])
    const merkleDistributorWithDeadlineFactory = await hre.ethers.getContractFactory(
      'MerkleDistributorWithDeadline',
      wallet0 as unknown as Signer,
    )
    // Set the endTime to be 1 year after currentTimestamp
    distributor = await merkleDistributorWithDeadlineFactory.deploy(
      await token.getAddress(),
      tree.getHexRoot(),
      currentTimestamp + 31536000,
      overrides,
    )
    await token.setBalance(await distributor.getAddress(), 201)
  })

  it('successful claim', async () => {
    const proof0 = tree.getProof(0, wallet0.address, 100n)
    await expect(distributor.claim(0, wallet0.address, 100, proof0, overrides))
      .to.emit(distributor, 'Claimed')
      .withArgs(0, wallet0.address, 100)
  })

  it('only owner can withdraw', async () => {
    distributor = distributor.connect(wallet1)
    await expect(distributor.withdraw(overrides)).to.be.revertedWith('Ownable: caller is not the owner')
  })

  it('cannot withdraw during claim window', async () => {
    await expect(distributor.withdraw(overrides)).to.be.revertedWithCustomError(distributor, 'NoWithdrawDuringClaim')
  })

  it('cannot claim after end time', async () => {
    const oneSecondAfterEndTime = currentTimestamp + 31536001
    await hre.ethers.provider.send('evm_mine', [oneSecondAfterEndTime])
    currentTimestamp = oneSecondAfterEndTime
    const proof0 = tree.getProof(0, wallet0.address, 100n)
    await expect(distributor.claim(0, wallet0.address, 100, proof0, overrides)).to.be.revertedWithCustomError(
      distributor,
      'ClaimWindowFinished',
    )
  })

  it('can withdraw after end time', async () => {
    const oneSecondAfterEndTime = currentTimestamp + 31536001
    await hre.ethers.provider.send('evm_mine', [oneSecondAfterEndTime])
    currentTimestamp = oneSecondAfterEndTime
    expect(await token.balanceOf(wallet0.address)).to.eq(0)
    await distributor.withdraw(overrides)
    expect(await token.balanceOf(wallet0.address)).to.eq(201)
  })

  it('only owner can withdraw even after end time', async () => {
    const oneSecondAfterEndTime = currentTimestamp + 31536001
    await hre.ethers.provider.send('evm_mine', [oneSecondAfterEndTime])
    distributor = distributor.connect(wallet1)
    await expect(distributor.withdraw(overrides)).to.be.revertedWith('Ownable: caller is not the owner')
  })
})
