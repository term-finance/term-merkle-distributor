import fs from 'fs';
import path from 'path';
import { parseBalanceMap } from '../src/parse-balance-map';
import { ethers } from 'hardhat';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Get arguments from environment variables instead of command line
const INPUT_FILE = process.env.INPUT_FILE;
const DEPLOY = process.env.DEPLOY === 'true';

// S3 configuration
const S3_BUCKET = process.env.S3_BUCKET;
const S3_REGION = process.env.S3_REGION || 'us-west-1';

// Create S3 client
const s3Client = new S3Client({ region: S3_REGION });

// Function to upload JSON to S3
async function uploadToS3(data: any, key: any) {
  if (!S3_BUCKET) {
    throw new Error('S3_BUCKET environment variable must be set for S3 upload');
  }
  
  console.log(`Uploading to S3 bucket ${S3_BUCKET} with key ${key}...`);
  
  const params = {
    Bucket: S3_BUCKET,
    Key: key,
    Body: JSON.stringify(data, null, 2),
    ContentType: 'application/json'
  };
  
  try {
    const response = await s3Client.send(new PutObjectCommand(params));
    console.log(`Successfully uploaded to s3://${S3_BUCKET}/${key}`);
    return response;
  } catch (error) {
    console.error('Error uploading to S3:', error);
    throw error;
  }
}

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
  
  // Generate output file name
  const baseFileName = path.basename(INPUT_FILE, path.extname(INPUT_FILE));
  const merkleFileName = `${baseFileName}.merkle.json`;
  
  // Save output to S3
  await uploadToS3(
    parsedBalances, 
    `merkle-distributions/${merkleFileName}`
  );
  
  // Still save locally if needed
  if (process.env.SAVE_LOCAL === 'true') {
    const outputPath = path.join(path.dirname(INPUT_FILE), merkleFileName);
    fs.writeFileSync(outputPath, JSON.stringify(parsedBalances, null, 2));
    console.log(`Merkle distribution data saved locally to ${outputPath}`);
  }
  
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
    
    // Upload deployment info to S3
    const deploymentFileName = `${baseFileName}.deployment.json`;
    await uploadToS3(
      deploymentInfo, 
      `merkle-deployments/${deploymentFileName}`
    );
    
    // Save locally if needed
    if (process.env.SAVE_LOCAL === 'true') {
      const deploymentPath = path.join(
        path.dirname(INPUT_FILE), 
        deploymentFileName
      );
      fs.writeFileSync(deploymentPath, JSON.stringify(deploymentInfo, null, 2));
      console.log(`Deployment information saved locally to ${deploymentPath}`);
    }
  }
}

// Execute the script
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });