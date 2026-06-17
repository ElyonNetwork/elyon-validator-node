const { Web3 } = require('web3');
const solc = require('solc');
const fs = require('fs');
const path = require('path');

const RPC_URL = process.env.RPC_URL || 'http://localhost:8545';
const DEPLOYER = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';
// Dev wallet private key 1 (well-known test key)
const PRIVATE_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001';

async function main() {
    const web3 = new Web3(RPC_URL);

    // Check connection
    const blockNumber = await web3.eth.getBlockNumber();
    console.log(`Connected to chain. Current block: ${blockNumber}`);

    const balance = await web3.eth.getBalance(DEPLOYER);
    console.log(`Deployer balance: ${web3.utils.fromWei(balance, 'ether')} ETH`);

    // Compile contract
    console.log('Compiling StakingContract.sol...');
    const contractSource = fs.readFileSync(
        path.join(__dirname, '..', 'contracts', 'StakingContract.sol'),
        'utf8'
    );

    const input = {
        language: 'Solidity',
        sources: { 'StakingContract.sol': { content: contractSource } },
        settings: {
            evmVersion: 'istanbul',
            outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
        }
    };

    const output = JSON.parse(solc.compile(JSON.stringify(input)));
    if (output.errors) {
        const errs = output.errors.filter(e => e.severity === 'error');
        if (errs.length > 0) {
            console.error('Compilation errors:', errs.map(e => e.message));
            process.exit(1);
        }
    }

    const contract = output.contracts['StakingContract.sol']['StakingContract'];
    const abi = contract.abi;
    const bytecode = '0x' + contract.evm.bytecode.object;
    console.log(`Contract compiled. Bytecode size: ${bytecode.length / 2} bytes`);

    // Deploy
    console.log('Deploying StakingContract...');
    const account = web3.eth.accounts.privateKeyToAccount(PRIVATE_KEY);
    web3.eth.accounts.wallet.add(account);

    const stakingContract = new web3.eth.Contract(abi);
    const deployTx = stakingContract.deploy({ data: bytecode });

    const gas = await deployTx.estimateGas({ from: DEPLOYER });
    console.log(`Estimated gas: ${gas}`);

    const deployed = await deployTx.send({
        from: DEPLOYER,
        gas: String(gas * 2n),
        gasPrice: '0'
    });

    const contractAddress = deployed.options.address;
    console.log(`StakingContract deployed at: ${contractAddress}`);

    // Stake 10 ETH from deployer
    console.log('Staking 10 ETH from deployer...');
    const stakeMethod = deployed.methods.stake();
    const stakeGas = await stakeMethod.estimateGas({
        from: DEPLOYER,
        value: web3.utils.toWei('10', 'ether')
    });

    const stakeTx = await stakeMethod.send({
        from: DEPLOYER,
        value: web3.utils.toWei('10', 'ether'),
        gas: String(stakeGas * 2n),
        gasPrice: '0'
    });
    console.log(`Staked 10 ETH. TX: ${stakeTx.transactionHash}`);

    // Check active validators
    const validators = await deployed.methods.getActiveValidators().call();
    console.log(`Active validators: ${JSON.stringify(validators)}`);

    // Save deployment info
    const deployInfo = {
        contractAddress,
        deployer: DEPLOYER,
        abi,
        blockNumber: Number(await web3.eth.getBlockNumber()),
        chainId: Number(await web3.eth.getChainId())
    };
    fs.writeFileSync(
        path.join(__dirname, '..', 'contracts', 'deployment.json'),
        JSON.stringify(deployInfo, null, 2)
    );
    console.log('Deployment info saved to contracts/deployment.json');
    console.log('Done!');
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
