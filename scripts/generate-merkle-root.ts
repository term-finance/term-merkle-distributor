import { program } from 'commander'
import fs from 'fs'
import { parseBalanceMap } from '../src/parse-balance-map'

async function deployMerkleDistributor(merkleRoot: string) {
  const airdropAsset = process.env.AIRDROP_ASSET;
  const { ethers } = require('hardhat');

  const MerkleDistributor = await ethers.getContractFactory('MerkleDistributor')
  const merkleDistributor = await MerkleDistributor.deploy(
    // USDC
    airdropAsset,
    merkleRoot
  )
  await merkleDistributor.deployed()
  console.log(`merkleDistributor deployed at ${merkleDistributor.address}`)
}

program
  .version('0.0.0')
  .requiredOption(
    '-i, --input <path>',
    'input JSON file location containing a map of account addresses to string balances'
  )

program.parse(process.argv)

const json = JSON.parse(fs.readFileSync(program.input, { encoding: 'utf8' }))

if (typeof json !== 'object') throw new Error('Invalid JSON')

console.log(JSON.stringify(parseBalanceMap(json)))

deployMerkleDistributor(json.merkleRoot);
