import fs from 'fs';
import path from 'path';
import { parseBalanceMap } from '../src/parse-balance-map';
import { ethers } from 'hardhat';

// Get arguments from environment variables instead of command line
const INPUT_FILE = process.env.INPUT_FILE;
const DEPLOY = process.env.DEPLOY === 'true';

async function main() {
  if (!INPUT_FILE) {
    throw new Error('INPUT_FILE environment variable must be set');
  }
  
  // Read and parse the input file
  console.log(`Reading balance data from ${INPUT_FILE}...`);
  
  const json = JSON.parse(fs.readFileSync(INPUT_FILE, { encoding: 'utf8' }));
  if (typeof json !== 'object') {
    throw new Error('Invalid JSON format');
  }
  
  // Generate the merkle root
  console.log('Generating merkle root...');
  const parsedBalances = parseBalanceMap(json);
  console.log('Merkle root generated:', parsedBalances.merkleRoot);
  console.log(JSON.stringify(parsedBalances, null, 2));
  
  // Save output to a file
  const outputFileName = path.basename(INPUT_FILE, path.extname(INPUT_FILE)) + '.merkle.json';
  const outputPath = path.join(path.dirname(INPUT_FILE), outputFileName);
  fs.writeFileSync(outputPath, JSON.stringify(parsedBalances, null, 2));
  console.log(`Merkle distribution data saved to ${outputPath}`);
  
  // Deploy if requested
  if (DEPLOY) {
    const airdropAsset = process.env.AIRDROP_ASSET;
    if (!airdropAsset) {
      console.error('AIRDROP_ASSET environment variable must be set for deployment');
      return process.exit(1);
    }
    const endTimestamp = process.env.END_TIMESTAMP;
    if (!endTimestamp) {
      console.error('END_TIMESTAMP environment variable must be set for deployment');
      return process.exit(1);
    }

    const adminAddress = process.env.ADMIN_ADDRESS;
    if (!adminAddress) {
      console.error('ADMIN_ADDRESS environment variable must be set for deployment');
      return process.exit(1);
    }
    
    console.log(`Deploying MerkleDistributor with token ${airdropAsset}...`);
    
    const [deployer] = await ethers.getSigners();
    console.log(`Deploying with account: ${deployer.address}`);
    
    const MerkleDistributor = await ethers.getContractFactory('MerkleDistributorWithDeadline');
    const merkleDistributor = await MerkleDistributor.deploy(
      airdropAsset,
      parsedBalances.merkleRoot,
      endTimestamp,
    );
    
    console.log('Waiting for deployment transaction...');
    await merkleDistributor.deployed();
    console.log(`MerkleDistributor deployed at ${merkleDistributor.address}`);
    await merkleDistributor.transferOwnership(adminAddress);
    console.log(`Ownership transferred to ${adminAddress}`);
    
    // Save deployment information
    const deploymentInfo = {
      merkleRoot: parsedBalances.merkleRoot,
      contractAddress: merkleDistributor.address,
      deploymentNetwork: (await ethers.provider.getNetwork()).name,
      deploymentTime: new Date().toISOString(),
      tokenAddress: airdropAsset
    };
    
    const deploymentPath = path.join(
      path.dirname(INPUT_FILE), 
      path.basename(INPUT_FILE, path.extname(INPUT_FILE)) + '.deployment.json'
    );
    fs.writeFileSync(deploymentPath, JSON.stringify(deploymentInfo, null, 2));
    console.log(`Deployment information saved to ${deploymentPath}`);
  }
}

// Execute the script
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });