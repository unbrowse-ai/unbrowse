// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// A stand-in for Arc's ERC-8004 IdentityRegistry in the node's tests: the calls and events the node uses, an
/// ERC-721's owner and balance, and nothing else. Its runtime code is what the tests put at the registry's address.
/// It mints as Arc's registry does, with ERC-721's safe-mint check: an owner with code (a key delegated under
/// EIP-7702) must answer `onERC721Received`, or the registration reverts.
contract Erc8004StandIn {
    uint256 public count;
    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => string) public tokenURI;
    mapping(uint256 => mapping(string => bytes)) internal meta;

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue);

    function register(string calldata agentURI) external returns (uint256 id) {
        id = ++count;
        ownerOf[id] = msg.sender;
        balanceOf[msg.sender] += 1;
        tokenURI[id] = agentURI;
        emit Registered(id, agentURI, msg.sender);
        if (msg.sender.code.length != 0) {
            (bool ok, bytes memory ret) = msg.sender.call(
                abi.encodeWithSignature("onERC721Received(address,address,uint256,bytes)", msg.sender, address(0), id, "")
            );
            require(ok && ret.length == 32 && bytes4(ret) == bytes4(0x150b7a02), "ERC721InvalidReceiver");
        }
    }

    function setAgentURI(uint256 id, string calldata u) external {
        require(ownerOf[id] == msg.sender);
        tokenURI[id] = u;
    }

    function setMetadata(uint256 id, string calldata k, bytes calldata v) external {
        require(ownerOf[id] == msg.sender);
        meta[id][k] = v;
        emit MetadataSet(id, k, k, v);
    }

    function getMetadata(uint256 id, string calldata k) external view returns (bytes memory) {
        return meta[id][k];
    }
}
