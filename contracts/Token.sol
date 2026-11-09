// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  Generic fixed-supply ERC-20 (Elyon Chain)
/// @notice Parameterized standard ERC-20 used to mint mirror assets
///         (USDC, BTC, ETH, TRX, SOL, Gold, …) on Elyon Chain. Full supply
///         minted to the deployer at construction. Fully ERC-20 compliant.
contract Token {
    string public name;
    string public symbol;
    uint8  public decimals;

    uint256 public totalSupply;

    mapping(address => uint256)                      public balanceOf;
    mapping(address => mapping(address => uint256))  public allowance;

    event Transfer(address indexed from,  address indexed to,      uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, uint8 _decimals, uint256 _initialSupplyTokens) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        totalSupply = _initialSupplyTokens * (10 ** uint256(_decimals));
        balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
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
        require(a >= amount, "Token: insufficient allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0),          "Token: zero recipient");
        require(balanceOf[from] >= amount, "Token: insufficient balance");
        unchecked {
            balanceOf[from] -= amount;
            balanceOf[to]   += amount;
        }
        emit Transfer(from, to, amount);
    }
}
