import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SkillRegistry } from "../target/types/skill_registry";
import { assert } from "chai";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";

describe("skill-registry", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SkillRegistry as Program<SkillRegistry>;
  const authority = provider.wallet;

  // PDAs
  let marketplacePda: anchor.web3.PublicKey;
  let agentPda: anchor.web3.PublicKey;
  let skillPda: anchor.web3.PublicKey;

  const skillId = "dexscreener-v1";

  before(async () => {
    // Derive PDAs
    [marketplacePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("marketplace")],
      program.programId
    );

    [agentPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), authority.publicKey.toBuffer()],
      program.programId
    );

    [skillPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("skill"), Buffer.from(skillId)],
      program.programId
    );
  });

  it("Initializes the marketplace", async () => {
    const feeBps = 250; // 2.5% fee

    await program.methods
      .initializeMarketplace(feeBps)
      .accounts({
        authority: authority.publicKey,
        marketplace: marketplacePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const marketplace = await program.account.marketplace.fetch(marketplacePda);
    assert.equal(marketplace.feeBps, feeBps);
    assert.equal(marketplace.totalSkills.toNumber(), 0);
    assert.equal(marketplace.totalPurchases.toNumber(), 0);
    assert.equal(marketplace.totalVolumeUsdc.toNumber(), 0);
    assert.ok(marketplace.authority.equals(authority.publicKey));
  });

  it("Registers an agent", async () => {
    const name = "foundry-ai";
    const metadataUri = "https://arweave.net/agent-metadata";

    await program.methods
      .registerAgent(name, metadataUri)
      .accounts({
        owner: authority.publicKey,
        agent: agentPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const agent = await program.account.agent.fetch(agentPda);
    assert.equal(agent.name, name);
    assert.equal(agent.metadataUri, metadataUri);
    assert.equal(agent.skillsPublished.toNumber(), 0);
    assert.equal(agent.skillsSold.toNumber(), 0);
    assert.equal(agent.totalEarnings.toNumber(), 0);
    assert.equal(agent.reputationScore, 0);
  });

  it("Registers a skill", async () => {
    const name = "DexScreener API";
    const description = "Real-time DEX analytics — pairs, tokens, price charts";
    const endpointCount = 10;
    const authType = { none: {} };
    const priceUsdc = new anchor.BN(1_000_000); // $1 USDC
    const metadataUri = "https://arweave.net/skill-dexscreener";

    await program.methods
      .registerSkill(
        skillId,
        name,
        description,
        endpointCount,
        authType,
        priceUsdc,
        metadataUri
      )
      .accounts({
        publisher: authority.publicKey,
        agent: agentPda,
        marketplace: marketplacePda,
        skill: skillPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const skill = await program.account.skill.fetch(skillPda);
    assert.equal(skill.skillId, skillId);
    assert.equal(skill.name, name);
    assert.equal(skill.description, description);
    assert.equal(skill.endpointCount, endpointCount);
    assert.equal(skill.priceUsdc.toNumber(), 1_000_000);
    assert.equal(skill.totalPurchases.toNumber(), 0);
    assert.equal(skill.isActive, true);

    // Check marketplace stats updated
    const marketplace = await program.account.marketplace.fetch(marketplacePda);
    assert.equal(marketplace.totalSkills.toNumber(), 1);

    // Check agent stats updated
    const agent = await program.account.agent.fetch(agentPda);
    assert.equal(agent.skillsPublished.toNumber(), 1);
  });

  it("Updates skill price", async () => {
    const newPrice = new anchor.BN(2_000_000); // $2 USDC

    await program.methods
      .updateSkillPrice(newPrice)
      .accounts({
        publisher: authority.publicKey,
        skill: skillPda,
      })
      .rpc();

    const skill = await program.account.skill.fetch(skillPda);
    assert.equal(skill.priceUsdc.toNumber(), 2_000_000);
  });

  it("Deactivates a skill", async () => {
    await program.methods
      .deactivateSkill()
      .accounts({
        publisher: authority.publicKey,
        skill: skillPda,
      })
      .rpc();

    const skill = await program.account.skill.fetch(skillPda);
    assert.equal(skill.isActive, false);
  });
});
