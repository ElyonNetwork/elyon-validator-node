// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  Elyon Test Token (ELNTST)
/// @notice Minimal ERC-20 with a single minter slot. The Faucet contract
///         holds the minter role and is the only authorised issuer.
///         Tokens carry no real-world economic value — testnet only.
contract ELNTST {
    string public constant name     = "Elyon Test Token";
    string public constant symbol   = "ELNTST";
    uint8  public constant decimals = 18;

    uint256 public totalSupply;
    address public admin;
    address public minter;          // Faucet contract address

    mapping(address => uint256)                      public balanceOf;
    mapping(address => mapping(address => uint256))  public allowance;

    event Transfer(address indexed from,  address indexed to,      uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MinterUpdated(address indexed previous, address indexed current);
    event AdminTransferred(address indexed previous, address indexed current);

    constructor() {
        admin  = msg.sender;
        minter = msg.sender;       // bootstrap; admin transfers to Faucet after deploy
        emit AdminTransferred(address(0), admin);
        emit MinterUpdated(address(0), minter);
    }

    modifier onlyAdmin() { require(msg.sender == admin, "ELNTST: not admin"); _; }

    function setMinter(address newMinter) external onlyAdmin {
        emit MinterUpdated(minter, newMinter);
        minter = newMinter;
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "ELNTST: zero admin");
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "ELNTST: not minter");
        require(to != address(0),    "ELNTST: zero recipient");
        totalSupply       += amount;
        balanceOf[to]     += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "ELNTST: insufficient allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "ELNTST: insufficient balance");
        require(to != address(0),          "ELNTST: zero recipient");
        balanceOf[from] -= amount;
        balanceOf[to]   += amount;
        emit Transfer(from, to, amount);
    }
}
