use anchor_lang::prelude::*;

declare_id!("6ZquzovU8joJ9rbyE5138obnC4Qz5XC6vyCW4f24sY7h");

/// Unbrowse Skill Registry — on-chain marketplace for agent API skills.
/// Agents register captured API skills, other agents purchase them via USDC.
/// Includes reputation tracking for skill quality.
#[program]
pub mod skill_registry {
    use super::*;

    /// Initialize the marketplace with an authority
    pub fn initialize_marketplace(
        ctx: Context<InitializeMarketplace>,
        fee_bps: u16, // Marketplace fee in basis points (e.g., 250 = 2.5%)
    ) -> Result<()> {
        require!(fee_bps <= 5000, ErrorCode::FeeTooHigh); // Max 50%

        let marketplace = &mut ctx.accounts.marketplace;
        marketplace.authority = ctx.accounts.authority.key();
        marketplace.fee_bps = fee_bps;
        marketplace.total_skills = 0;
        marketplace.total_purchases = 0;
        marketplace.total_volume_usdc = 0;
        marketplace.bump = ctx.bumps.marketplace;

        msg!("Marketplace initialized with {}bps fee", fee_bps);
        Ok(())
    }

    /// Register an agent identity for reputation tracking
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        name: String,
        metadata_uri: String, // IPFS/Arweave URI for agent metadata
    ) -> Result<()> {
        require!(name.len() <= 32, ErrorCode::NameTooLong);
        require!(metadata_uri.len() <= 200, ErrorCode::UriTooLong);

        let agent = &mut ctx.accounts.agent;
        agent.owner = ctx.accounts.owner.key();
        agent.name = name;
        agent.metadata_uri = metadata_uri;
        agent.skills_published = 0;
        agent.skills_sold = 0;
        agent.total_earnings = 0;
        agent.reputation_score = 0;
        agent.total_ratings = 0;
        agent.created_at = Clock::get()?.unix_timestamp;
        agent.bump = ctx.bumps.agent;

        msg!("Agent registered: {}", agent.name);
        Ok(())
    }

    /// Register a new API skill on the marketplace
    pub fn register_skill(
        ctx: Context<RegisterSkill>,
        skill_id: String,      // Unique skill identifier (e.g., "dexscreener-v1")
        name: String,           // Human readable name
        description: String,    // What this skill does
        endpoint_count: u16,    // Number of API endpoints
        auth_type: AuthType,    // Auth method required
        price_usdc: u64,        // Price in USDC (6 decimals, e.g., 1_000_000 = $1)
        metadata_uri: String,   // IPFS/Arweave URI with full skill definition
    ) -> Result<()> {
        require!(skill_id.len() <= 64, ErrorCode::SkillIdTooLong);
        require!(name.len() <= 64, ErrorCode::NameTooLong);
        require!(description.len() <= 256, ErrorCode::DescriptionTooLong);
        require!(metadata_uri.len() <= 200, ErrorCode::UriTooLong);
        require!(price_usdc > 0, ErrorCode::PriceMustBePositive);

        let skill = &mut ctx.accounts.skill;
        skill.publisher = ctx.accounts.publisher.key();
        skill.agent = ctx.accounts.agent.key();
        skill.skill_id = skill_id;
        skill.name = name;
        skill.description = description;
        skill.endpoint_count = endpoint_count;
        skill.auth_type = auth_type;
        skill.price_usdc = price_usdc;
        skill.metadata_uri = metadata_uri;
        skill.total_purchases = 0;
        skill.total_revenue = 0;
        skill.avg_rating = 0;
        skill.total_ratings = 0;
        skill.is_active = true;
        skill.created_at = Clock::get()?.unix_timestamp;
        skill.updated_at = Clock::get()?.unix_timestamp;
        skill.bump = ctx.bumps.skill;

        // Update agent stats
        let agent = &mut ctx.accounts.agent;
        agent.skills_published = agent.skills_published.checked_add(1).unwrap();

        // Update marketplace stats
        let marketplace = &mut ctx.accounts.marketplace;
        marketplace.total_skills = marketplace.total_skills.checked_add(1).unwrap();

        msg!("Skill registered: {} at {} USDC", skill.name, price_usdc);
        Ok(())
    }

    /// Purchase a skill — transfers USDC from buyer to seller (minus marketplace fee)
    pub fn purchase_skill(ctx: Context<PurchaseSkill>) -> Result<()> {
        let skill = &ctx.accounts.skill;
        require!(skill.is_active, ErrorCode::SkillNotActive);

        let price = skill.price_usdc;
        let marketplace = &ctx.accounts.marketplace;
        let fee = (price as u128)
            .checked_mul(marketplace.fee_bps as u128)
            .unwrap()
            .checked_div(10_000)
            .unwrap() as u64;
        let seller_amount = price.checked_sub(fee).unwrap();

        // Transfer USDC from buyer to seller using SPL Token transfer
        let transfer_to_seller_ix = spl_token::instruction::transfer(
            ctx.accounts.token_program.key,
            ctx.accounts.buyer_token_account.key,
            ctx.accounts.seller_token_account.key,
            ctx.accounts.buyer.key,
            &[],
            seller_amount,
        )?;
        anchor_lang::solana_program::program::invoke(
            &transfer_to_seller_ix,
            &[
                ctx.accounts.buyer_token_account.to_account_info(),
                ctx.accounts.seller_token_account.to_account_info(),
                ctx.accounts.buyer.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
        )?;

        // Transfer fee to marketplace treasury
        if fee > 0 {
            let transfer_fee_ix = spl_token::instruction::transfer(
                ctx.accounts.token_program.key,
                ctx.accounts.buyer_token_account.key,
                ctx.accounts.treasury_token_account.key,
                ctx.accounts.buyer.key,
                &[],
                fee,
            )?;
            anchor_lang::solana_program::program::invoke(
                &transfer_fee_ix,
                &[
                    ctx.accounts.buyer_token_account.to_account_info(),
                    ctx.accounts.treasury_token_account.to_account_info(),
                    ctx.accounts.buyer.to_account_info(),
                    ctx.accounts.token_program.to_account_info(),
                ],
            )?;
        }

        // Record the purchase
        let purchase = &mut ctx.accounts.purchase;
        purchase.buyer = ctx.accounts.buyer.key();
        purchase.skill = ctx.accounts.skill.key();
        purchase.price_paid = price;
        purchase.fee_paid = fee;
        purchase.purchased_at = Clock::get()?.unix_timestamp;
        purchase.rating = 0; // Not rated yet
        purchase.bump = ctx.bumps.purchase;

        // Update skill stats
        let skill = &mut ctx.accounts.skill;
        skill.total_purchases = skill.total_purchases.checked_add(1).unwrap();
        skill.total_revenue = skill.total_revenue.checked_add(price).unwrap();

        // Update seller agent stats
        let seller_agent = &mut ctx.accounts.seller_agent;
        seller_agent.skills_sold = seller_agent.skills_sold.checked_add(1).unwrap();
        seller_agent.total_earnings = seller_agent.total_earnings.checked_add(seller_amount).unwrap();

        // Update marketplace stats
        let marketplace = &mut ctx.accounts.marketplace;
        marketplace.total_purchases = marketplace.total_purchases.checked_add(1).unwrap();
        marketplace.total_volume_usdc = marketplace.total_volume_usdc.checked_add(price).unwrap();

        msg!(
            "Skill purchased for {} USDC (fee: {})",
            price,
            fee
        );
        Ok(())
    }

    /// Rate a purchased skill (1-5 stars)
    pub fn rate_skill(ctx: Context<RateSkill>, rating: u8) -> Result<()> {
        require!(rating >= 1 && rating <= 5, ErrorCode::InvalidRating);

        let purchase = &mut ctx.accounts.purchase;
        require!(purchase.rating == 0, ErrorCode::AlreadyRated);
        purchase.rating = rating;

        // Update skill average rating
        let skill = &mut ctx.accounts.skill;
        let total = skill.avg_rating as u64 * skill.total_ratings as u64 + rating as u64;
        skill.total_ratings = skill.total_ratings.checked_add(1).unwrap();
        skill.avg_rating = (total / skill.total_ratings as u64) as u8;

        // Update agent reputation
        let agent = &mut ctx.accounts.seller_agent;
        let agent_total =
            agent.reputation_score as u64 * agent.total_ratings as u64 + rating as u64;
        agent.total_ratings = agent.total_ratings.checked_add(1).unwrap();
        agent.reputation_score = (agent_total / agent.total_ratings as u64) as u8;

        msg!("Skill rated {} stars", rating);
        Ok(())
    }

    /// Update skill price (publisher only)
    pub fn update_skill_price(ctx: Context<UpdateSkill>, new_price: u64) -> Result<()> {
        require!(new_price > 0, ErrorCode::PriceMustBePositive);

        let skill = &mut ctx.accounts.skill;
        skill.price_usdc = new_price;
        skill.updated_at = Clock::get()?.unix_timestamp;

        msg!("Skill price updated to {} USDC", new_price);
        Ok(())
    }

    /// Deactivate a skill (publisher only)
    pub fn deactivate_skill(ctx: Context<UpdateSkill>) -> Result<()> {
        let skill = &mut ctx.accounts.skill;
        skill.is_active = false;
        skill.updated_at = Clock::get()?.unix_timestamp;

        msg!("Skill deactivated");
        Ok(())
    }
}

// ============================================================
// Account Structures
// ============================================================

#[account]
#[derive(InitSpace)]
pub struct Marketplace {
    pub authority: Pubkey,        // Admin authority
    pub fee_bps: u16,             // Fee in basis points
    pub total_skills: u64,        // Total skills registered
    pub total_purchases: u64,     // Total purchases made
    pub total_volume_usdc: u64,   // Total USDC volume
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Agent {
    pub owner: Pubkey,            // Agent's wallet
    #[max_len(32)]
    pub name: String,             // Agent name
    #[max_len(200)]
    pub metadata_uri: String,     // IPFS/Arweave URI
    pub skills_published: u64,    // Number of skills published
    pub skills_sold: u64,         // Total sales across all skills
    pub total_earnings: u64,      // Total USDC earned
    pub reputation_score: u8,     // Average rating (1-5)
    pub total_ratings: u64,       // Number of ratings received
    pub created_at: i64,          // Unix timestamp
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Skill {
    pub publisher: Pubkey,        // Publisher's wallet
    pub agent: Pubkey,            // Publisher's agent PDA
    #[max_len(64)]
    pub skill_id: String,         // Unique identifier
    #[max_len(64)]
    pub name: String,             // Display name
    #[max_len(256)]
    pub description: String,      // What this skill does
    pub endpoint_count: u16,      // Number of API endpoints
    pub auth_type: AuthType,      // Auth method
    pub price_usdc: u64,          // Price in USDC (6 decimals)
    #[max_len(200)]
    pub metadata_uri: String,     // Full skill definition URI
    pub total_purchases: u64,     // Times purchased
    pub total_revenue: u64,       // Total USDC earned
    pub avg_rating: u8,           // Average rating (1-5)
    pub total_ratings: u64,       // Number of ratings
    pub is_active: bool,          // Whether skill is available
    pub created_at: i64,          // Unix timestamp
    pub updated_at: i64,          // Last update
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Purchase {
    pub buyer: Pubkey,            // Buyer's wallet
    pub skill: Pubkey,            // Skill PDA
    pub price_paid: u64,          // USDC paid
    pub fee_paid: u64,            // Fee portion
    pub purchased_at: i64,        // Unix timestamp
    pub rating: u8,               // 0 = not rated, 1-5 = rated
    pub bump: u8,
}

// ============================================================
// Auth Type Enum
// ============================================================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum AuthType {
    None,       // No auth needed (public APIs)
    Bearer,     // Bearer token
    Cookie,     // Cookie-based auth
    ApiKey,     // API key
    OAuth,      // OAuth flow
    Custom,     // Custom auth method
}

// ============================================================
// Context Structs (Account Validation)
// ============================================================

#[derive(Accounts)]
pub struct InitializeMarketplace<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Marketplace::INIT_SPACE,
        seeds = [b"marketplace"],
        bump
    )]
    pub marketplace: Account<'info, Marketplace>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(name: String)]
pub struct RegisterAgent<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + Agent::INIT_SPACE,
        seeds = [b"agent", owner.key().as_ref()],
        bump
    )]
    pub agent: Account<'info, Agent>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(skill_id: String)]
pub struct RegisterSkill<'info> {
    #[account(mut)]
    pub publisher: Signer<'info>,

    #[account(
        mut,
        seeds = [b"agent", publisher.key().as_ref()],
        bump = agent.bump,
        constraint = agent.owner == publisher.key() @ ErrorCode::Unauthorized
    )]
    pub agent: Account<'info, Agent>,

    #[account(
        mut,
        seeds = [b"marketplace"],
        bump = marketplace.bump
    )]
    pub marketplace: Account<'info, Marketplace>,

    #[account(
        init,
        payer = publisher,
        space = 8 + Skill::INIT_SPACE,
        seeds = [b"skill", skill_id.as_bytes()],
        bump
    )]
    pub skill: Account<'info, Skill>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PurchaseSkill<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"marketplace"],
        bump = marketplace.bump
    )]
    pub marketplace: Account<'info, Marketplace>,

    #[account(
        mut,
        constraint = skill.is_active @ ErrorCode::SkillNotActive
    )]
    pub skill: Account<'info, Skill>,

    #[account(
        mut,
        seeds = [b"agent", skill.publisher.as_ref()],
        bump = seller_agent.bump
    )]
    pub seller_agent: Account<'info, Agent>,

    #[account(
        init,
        payer = buyer,
        space = 8 + Purchase::INIT_SPACE,
        seeds = [b"purchase", buyer.key().as_ref(), skill.key().as_ref()],
        bump
    )]
    pub purchase: Account<'info, Purchase>,

    /// Buyer's USDC token account
    /// CHECK: Validated by SPL Token program during transfer
    #[account(mut)]
    pub buyer_token_account: UncheckedAccount<'info>,

    /// Seller's USDC token account
    /// CHECK: Validated by SPL Token program during transfer
    #[account(mut)]
    pub seller_token_account: UncheckedAccount<'info>,

    /// Marketplace treasury USDC token account
    /// CHECK: Validated by SPL Token program during transfer
    #[account(mut)]
    pub treasury_token_account: UncheckedAccount<'info>,

    /// CHECK: SPL Token program
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RateSkill<'info> {
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"purchase", buyer.key().as_ref(), skill.key().as_ref()],
        bump = purchase.bump,
        constraint = purchase.buyer == buyer.key() @ ErrorCode::Unauthorized
    )]
    pub purchase: Account<'info, Purchase>,

    #[account(mut)]
    pub skill: Account<'info, Skill>,

    #[account(
        mut,
        seeds = [b"agent", skill.publisher.as_ref()],
        bump = seller_agent.bump
    )]
    pub seller_agent: Account<'info, Agent>,
}

#[derive(Accounts)]
pub struct UpdateSkill<'info> {
    pub publisher: Signer<'info>,

    #[account(
        mut,
        constraint = skill.publisher == publisher.key() @ ErrorCode::Unauthorized
    )]
    pub skill: Account<'info, Skill>,
}

// ============================================================
// Error Codes
// ============================================================

#[error_code]
pub enum ErrorCode {
    #[msg("Fee must be <= 5000 bps (50%)")]
    FeeTooHigh,
    #[msg("Name must be <= 32 characters")]
    NameTooLong,
    #[msg("URI must be <= 200 characters")]
    UriTooLong,
    #[msg("Skill ID must be <= 64 characters")]
    SkillIdTooLong,
    #[msg("Description must be <= 256 characters")]
    DescriptionTooLong,
    #[msg("Price must be > 0")]
    PriceMustBePositive,
    #[msg("Skill is not active")]
    SkillNotActive,
    #[msg("Rating must be 1-5")]
    InvalidRating,
    #[msg("Already rated this purchase")]
    AlreadyRated,
    #[msg("Unauthorized")]
    Unauthorized,
}
