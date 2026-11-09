// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  Tether USD (USDT) — Elyon Chain
/// @notice Standard fixed-supply ERC-20 modeled on Ethereum's USDT
///         (name "Tether USD", symbol "USDT", 6 decimals). The full supply
///         is minted to the deployer at construction. Behaves as a normal,
///         fully ERC-20-compliant token (returns bool, emits Transfer/Approval).
contract USDT {
    string public constant name     = "Tether USD";
    string public constant symbol   = "USDT";
    uint8  public constant decimals = 6;

    uint256 public totalSupply;

    mapping(address => uint256)                      public balanceOf;
    mapping(address => mapping(address => uint256))  public allowance;

    event Transfer(address indexed from,  address indexed to,      uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @param initialSupplyTokens whole-token supply (e.g. 10_000_000); scaled by decimals.
    constructor(uint256 initialSupplyTokens) {
        totalSupply = initialSupplyTokens * (10 ** uint256(decimals));
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
        require(a >= amount, "USDT: insufficient allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0),          "USDT: zero recipient");
        require(balanceOf[from] >= amount, "USDT: insufficient balance");
        unchecked {
            balanceOf[from] -= amount;
            balanceOf[to]   += amount;
        }
        emit Transfer(from, to, amount);
    }
}
