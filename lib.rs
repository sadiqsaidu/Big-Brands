use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use std::convert::TryFrom;

declare_id!("EAGuNCoNXwjqNdfi5qJAXCmdL9ngxvnNhTUz1SZSrLK7");

#[program]
pub mod brand_nft_marketplace {
    use super::*;

    pub fn initialize_marketplace(ctx: Context<InitializeMarketplace>) -> Result<()> {
        let marketplace = &mut ctx.accounts.marketplace;
        marketplace.authority = ctx.accounts.authority.key();
        marketplace.treasury = ctx.accounts.treasury.key();
        Ok(())
    }

    pub fn list_nft(
        ctx: Context<ListNFT>,
        initial_price: u64,
        fraction_supply: u64,
        community_reward_percentage: u8,
    ) -> Result<()> {
        require!(
            community_reward_percentage <= 100,
            ErrorCode::InvalidPercentage
        );
        require!(fraction_supply > 0, ErrorCode::InvalidSupply);
        require!(initial_price > 0, ErrorCode::InvalidPrice);

        let listed_nft = &mut ctx.accounts.listed_nft;
        listed_nft.owner = ctx.accounts.owner.key();
        listed_nft.nft_mint = ctx.accounts.nft_mint.key();
        listed_nft.fraction_mint = ctx.accounts.fraction_mint.key();
        listed_nft.escrow_account = ctx.accounts.escrow_account.key();
        listed_nft.initial_price = initial_price;
        listed_nft.current_price = initial_price;
        listed_nft.fraction_supply = fraction_supply;
        listed_nft.community_reward_percentage = community_reward_percentage;

        // Transfer NFT to escrow
        let cpi_accounts = Transfer {
            from: ctx.accounts.owner_nft_account.to_account_info(),
            to: ctx.accounts.escrow_account.to_account_info(),
            authority: ctx.accounts.owner.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, 1)?;

        // Mint fractional tokens
        let seeds = &[
            b"marketplace",
            ctx.accounts.marketplace.to_account_info().key.as_ref(),
            &[ctx.bumps.marketplace],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = token::MintTo {
            mint: ctx.accounts.fraction_mint.to_account_info(),
            to: ctx.accounts.owner_fraction_account.to_account_info(),
            authority: ctx.accounts.marketplace.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);

        let owner_amount = fraction_supply
            .checked_mul(
                100u64
                    .checked_sub(community_reward_percentage as u64)
                    .unwrap(),
            ).unwrap()
            .checked_div(100)
            .unwrap();
        token::mint_to(cpi_ctx, owner_amount)?;

        // Mint community reward tokens
        let cpi_accounts = token::MintTo {
            mint: ctx.accounts.fraction_mint.to_account_info(),
            to: ctx.accounts.community_reward_account.to_account_info(),
            authority: ctx.accounts.marketplace.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);

        let community_amount = fraction_supply
            .checked_mul(community_reward_percentage as u64)
            .unwrap()
            .checked_div(100)
            .unwrap();
        token::mint_to(cpi_ctx, community_amount)?;

        emit!(NFTListed {
            nft_mint: ctx.accounts.nft_mint.key(),
            owner: ctx.accounts.owner.key(),
            initial_price,
            fraction_supply,
            community_reward_percentage,
        });

        Ok(())
    }

    // new buy_fraction function
    pub fn buy_fraction(ctx: Context<BuyFraction>, amount: u64) -> Result<()> {
        let listed_nft = &mut ctx.accounts.listed_nft;

        require!(amount > 0, ErrorCode::InvalidAmount);

        // Calculate price based on bonding curve

        let price =
            calculate_buy_price(listed_nft.current_price, amount, listed_nft.fraction_supply)?;

        // Transfer SOL from buyer to seller
        let cpi_accounts = anchor_lang::system_program::Transfer {
            from: ctx.accounts.buyer.to_account_info(),
            to: ctx.accounts.seller.to_account_info(),
        };
        let cpi_program = ctx.accounts.system_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        anchor_lang::system_program::transfer(cpi_ctx, price)?;

        // Transfer fractional tokens to buyer
        let cpi_accounts = Transfer {
            from: ctx.accounts.fraction_treasury.to_account_info(),
            to: ctx.accounts.buyer_fraction_account.to_account_info(),
            authority: ctx.accounts.marketplace.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let seeds = &[
            b"marketplace",
            ctx.accounts.marketplace.to_account_info().key.as_ref(),
            &[ctx.bumps.marketplace],
        ];
        let signer = &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        token::transfer(cpi_ctx, amount)?;

        // Update current price
        let new_price = calculate_new_price(
            listed_nft.current_price,
            amount,
            listed_nft.fraction_supply,
            true,
        )?;
        listed_nft.current_price = new_price;

        let nft_price = calculate_nft_price(new_price, listed_nft.fraction_supply)?;

        emit!(PriceUpdated {
            nft_mint: listed_nft.nft_mint,
            new_fraction_price: new_price,
            new_nft_price: nft_price,
        });

        Ok(())
    }

    pub fn sell_fraction(ctx: Context<SellFraction>, amount: u64) -> Result<()> {
        let listed_nft = &mut ctx.accounts.listed_nft;

        require!(amount > 0, ErrorCode::InvalidAmount);

        // Calculate price based on bonding curve
        let price =
            calculate_sell_price(listed_nft.current_price, amount, listed_nft.fraction_supply)?;

        // Transfer fractional tokens from seller to contract
        let cpi_accounts = Transfer {
            from: ctx.accounts.seller_fraction_account.to_account_info(),
            to: ctx.accounts.fraction_treasury.to_account_info(),
            authority: ctx.accounts.seller.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        // new transfer sol to seller
        let cpi_accounts = anchor_lang::system_program::Transfer {
            from: ctx.accounts.marketplace.to_account_info(),
            to: ctx.accounts.seller.to_account_info(),
        };
        let cpi_program = ctx.accounts.system_program.to_account_info();
        let seeds = &[
            b"marketplace",
            ctx.accounts.marketplace.to_account_info().key.as_ref(),
            &[ctx.bumps.marketplace],
        ];
        let signer = &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        anchor_lang::system_program::transfer(cpi_ctx, price)?;

        // Update current price
        let new_price = calculate_new_price(
            listed_nft.current_price,
            amount,
            listed_nft.fraction_supply,
            false,
        )?;
        listed_nft.current_price = new_price;

        let nft_price = calculate_nft_price(new_price, listed_nft.fraction_supply)?;

        emit!(PriceUpdated {
            nft_mint: listed_nft.nft_mint,
            new_fraction_price: new_price,
            new_nft_price: nft_price,
        });

        Ok(())
    }

    pub fn buy_nft(ctx: Context<BuyNFT>) -> Result<()> {
        let listed_nft = &mut ctx.accounts.listed_nft;

        // Calculate buyout price (slightly higher than current total value)
        let buyout_price =
            calculate_nft_price(listed_nft.current_price, listed_nft.fraction_supply)?;

        // new trasnfer sol from buyer to contract
        let cpi_accounts = anchor_lang::system_program::Transfer {
            from: ctx.accounts.buyer.to_account_info(),
            to: ctx.accounts.marketplace.to_account_info(),
        };
        let cpi_program = ctx.accounts.system_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        anchor_lang::system_program::transfer(cpi_ctx, buyout_price)?;

        // Transfer NFT to buyer
        let seeds = &[
            b"marketplace",
            ctx.accounts.marketplace.to_account_info().key.as_ref(),
            &[ctx.bumps.marketplace],
        ];
        let signer = &[&seeds[..]];
        let cpi_accounts = Transfer {
            from: ctx.accounts.escrow_account.to_account_info(),
            to: ctx.accounts.buyer_nft_account.to_account_info(),
            authority: ctx.accounts.marketplace.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        token::transfer(cpi_ctx, 1)?;

        // Mark NFT as sold
        listed_nft.owner = ctx.accounts.buyer.key();

        emit!(NFTSold {
            nft_mint: listed_nft.nft_mint,
            new_owner: ctx.accounts.buyer.key(),
            sale_price: buyout_price,
        });

        Ok(())
    }

    pub fn redeem_fractions(ctx: Context<RedeemFractions>) -> Result<()> {
        let listed_nft = &ctx.accounts.listed_nft;
        let fraction_balance = ctx.accounts.holder_fraction_account.amount;

        // Calculate redemption value
        let total_value = listed_nft.current_price;
        let redemption_value = (total_value as u128 * fraction_balance as u128
            / listed_nft.fraction_supply as u128) as u64;

        // Burn fractional tokens
        let cpi_accounts = token::Burn {
            mint: ctx.accounts.fraction_mint.to_account_info(),
            from: ctx.accounts.holder_fraction_account.to_account_info(),
            authority: ctx.accounts.token_holder.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::burn(cpi_ctx, fraction_balance)?;

        // Transfer SOL to token holder
        let seeds = &[
            b"marketplace",
            ctx.accounts.marketplace.to_account_info().key.as_ref(),
            &[ctx.bumps.marketplace],
        ];
        let signer = &[&seeds[..]];

        // transfer sol to token holder
        let cpi_accounts = anchor_lang::system_program::Transfer {
            from: ctx.accounts.marketplace.to_account_info(),
            to: ctx.accounts.token_holder.to_account_info(),
        };
        let cpi_program = ctx.accounts.system_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        anchor_lang::system_program::transfer(cpi_ctx, redemption_value)?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeMarketplace<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 32,
        seeds = [b"marketplace"],
        bump
    )]
    pub marketplace: Account<'info, Marketplace>,
    /// CHECK: This is not dangerous because we don't read or write from this account
    pub treasury: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ListNFT<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 1
    )]
    pub listed_nft: Account<'info, ListedNFT>,
    pub nft_mint: Account<'info, Mint>,
    #[account(mut)]
    pub owner_nft_account: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = owner,
        token::mint = nft_mint,
        token::authority = marketplace
    )]
    pub escrow_account: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = owner,
        mint::decimals = 0,
        mint::authority = marketplace
    )]
    pub fraction_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = owner,
        associated_token::mint = fraction_mint,
        associated_token::authority = owner
    )]
    pub owner_fraction_account: Account<'info, TokenAccount>,
    /// CHECK: This is not dangerous because we don't read or write from this account
    pub community_reward_account: AccountInfo<'info>,
    #[account(seeds = [b"marketplace"], bump)]
    pub marketplace: Account<'info, Marketplace>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct BuyFraction<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: This is not dangerous because we don't read or write from this account
    #[account(mut)]
    pub seller: AccountInfo<'info>,
    #[account(mut)]
    pub listed_nft: Account<'info, ListedNFT>,
    #[account(mut)]
    pub fraction_treasury: Account<'info, TokenAccount>,
    #[account(mut)]
    pub buyer_fraction_account: Account<'info, TokenAccount>,
    #[account(seeds = [b"marketplace"], bump)]
    pub marketplace: Account<'info, Marketplace>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SellFraction<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut)]
    pub listed_nft: Account<'info, ListedNFT>,
    #[account(mut)]
    pub seller_fraction_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub fraction_treasury: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"marketplace"], bump)]
    pub marketplace: Account<'info, Marketplace>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyNFT<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut)]
    pub listed_nft: Account<'info, ListedNFT>,
    #[account(mut)]
    pub escrow_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub buyer_nft_account: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"marketplace"], bump)]
    pub marketplace: Account<'info, Marketplace>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RedeemFractions<'info> {
    #[account(mut)]
    pub token_holder: Signer<'info>,
    #[account(mut)]
    pub listed_nft: Account<'info, ListedNFT>,
    #[account(mut)]
    pub fraction_mint: Account<'info, Mint>,
    #[account(mut)]
    pub holder_fraction_account: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"marketplace"], bump)]
    pub marketplace: Account<'info, Marketplace>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Marketplace {
    pub authority: Pubkey,
    pub treasury: Pubkey,
}

#[account]
pub struct ListedNFT {
    pub owner: Pubkey,
    pub nft_mint: Pubkey,
    pub fraction_mint: Pubkey,
    pub escrow_account: Pubkey,
    pub initial_price: u64,
    pub current_price: u64,
    pub fraction_supply: u64,
    pub community_reward_percentage: u8,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid percentage")]
    InvalidPercentage,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Invalid supply")]
    InvalidSupply,
    #[msg("Invalid price")]
    InvalidPrice,
    #[msg("Invalid amount")]
    InvalidAmount,
}

// Events
#[event]
pub struct NFTListed {
    pub nft_mint: Pubkey,
    pub owner: Pubkey,
    pub initial_price: u64,
    pub fraction_supply: u64,
    pub community_reward_percentage: u8,
}

#[event]
pub struct PriceUpdated {
    pub nft_mint: Pubkey,
    pub new_fraction_price: u64,
    pub new_nft_price: u64,
}

#[event]
pub struct NFTSold {
    pub nft_mint: Pubkey,
    pub new_owner: Pubkey,
    pub sale_price: u64,
}

// Helper functions
fn calculate_buy_price(current_price: u64, amount: u64, total_supply: u64) -> Result<u64> {
    let new_supply = total_supply
        .checked_add(amount)
        .ok_or(ErrorCode::ArithmeticOverflow)?;
    let new_price = (current_price as u128)
        .checked_mul(new_supply as u128)
        .ok_or(ErrorCode::ArithmeticOverflow)?
        .checked_div(total_supply as u128)
        .ok_or(ErrorCode::ArithmeticOverflow)?;
    Ok(u64::try_from(new_price).map_err(|_| ErrorCode::ArithmeticOverflow)?)
}

fn calculate_sell_price(current_price: u64, amount: u64, total_supply: u64) -> Result<u64> {
    let new_supply = total_supply
        .checked_sub(amount)
        .ok_or(ErrorCode::ArithmeticOverflow)?;
    let new_price = (current_price as u128)
        .checked_mul(new_supply as u128)
        .ok_or(ErrorCode::ArithmeticOverflow)?
        .checked_div(total_supply as u128)
        .ok_or(ErrorCode::ArithmeticOverflow)?;
    Ok(u64::try_from(new_price).map_err(|_| ErrorCode::ArithmeticOverflow)?)
}

fn calculate_new_price(
    current_price: u64,
    amount: u64,
    total_supply: u64,
    is_buy: bool,
) -> Result<u64> {
    if is_buy {
        calculate_buy_price(current_price, amount, total_supply)
    } else {
        calculate_sell_price(current_price, amount, total_supply)
    }
}

fn calculate_nft_price(current_fraction_price: u64, total_supply: u64) -> Result<u64> {
    (current_fraction_price as u128)
        .checked_mul(total_supply as u128)
        .ok_or(error!(ErrorCode::ArithmeticOverflow))?
        .checked_mul(105)
        .ok_or(error!(ErrorCode::ArithmeticOverflow))?
        .checked_div(100)
        .ok_or(error!(ErrorCode::ArithmeticOverflow))?
        .try_into()
        .map_err(|_| error!(ErrorCode::ArithmeticOverflow))
}