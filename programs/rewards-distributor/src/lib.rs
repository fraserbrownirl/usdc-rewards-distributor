use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::HASH_BYTES;
use solana_security_txt::security_txt;

use instructions::*;

mod error;
mod instructions;
mod state;

security_txt! {
    name: "POD Miner Rewards Distributor",
    project_url: "https://www.pod-miner.com",
    contacts: "mailto:security@pod-miner.com",
    policy: "https://www.pod-miner.com/security",
    preferred_languages: "en",
    source_code: "https://github.com/fraserbrownirl/usdc-rewards-distributor"
}

declare_id!("6S7aGNpCdT8ADoVXUwQXJqVg63GRx9uteHDAycngyQcK");

#[program]
pub mod rewards_distributor {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, updater: Pubkey) -> Result<()> {
        handle_initialize(ctx, updater)
    }

    pub fn claim(
        ctx: Context<Claim>,
        total_amount: u64,
        proof: Vec<[u8; HASH_BYTES]>,
    ) -> Result<()> {
        ctx.accounts.handle_claim(total_amount, proof)
    }

    pub fn update_root(ctx: Context<UpdateRoot>, new_root: [u8; HASH_BYTES]) -> Result<()> {
        ctx.accounts.handle_update_root(new_root)
    }

    pub fn set_admin(ctx: Context<SetAdmin>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.handle_set_admin(new_admin)
    }

    pub fn set_updater(ctx: Context<SetUpdater>, new_updater: Pubkey) -> Result<()> {
        ctx.accounts.handle_set_updater(new_updater)
    }

    pub fn shutdown(ctx: Context<Shutdown>) -> Result<()> {
        ctx.accounts.handle_shutdown()
    }
}
