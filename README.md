# Big-Brands

Big-Brands is a sophisticated NFT marketplace built on Solana using Anchor, enabling **fractional ownership** of NFTs. This allows NFT owners to list their assets, mint fractional tokens, and let others buy, sell, or redeem fractions. The marketplace uses a bonding curve for dynamic pricing and supports full NFT buyouts.

## Features

- **Marketplace Initialization:** Deploy a marketplace with a designated authority and treasury.
- **NFT Listing:** List NFTs, transfer them to escrow, and mint fractional tokens (with a configurable community reward).
- **Fractional Trading:** Buy and sell NFT fractions with prices determined by a bonding curve.
- **Buyout:** Purchase the entire NFT at a dynamically calculated price.
- **Fraction Redemption:** Fraction holders can redeem their tokens for a proportional share of SOL.

## How It Works

### 1. Marketplace Initialization

The marketplace is initialized with an authority and treasury account. This sets up the program's state for managing listings and transactions.

### 2. Listing an NFT

- The NFT owner lists their NFT, which is transferred to an escrow account controlled by the marketplace.
- Fractional tokens are minted: a portion goes to the owner, and a percentage (configurable) is reserved for community rewards.

### 3. Fractional Trading

- **Buy Fractions:** Users can buy fractions by paying SOL to the seller. The price is determined by a bonding curve, and the fraction tokens are transferred from the treasury to the buyer.
- **Sell Fractions:** Fraction holders can sell their tokens back to the treasury for SOL, with the price dynamically adjusted.

### 4. NFT Buyout

A user can buy the entire NFT by paying the calculated buyout price. Ownership of the NFT is transferred from escrow to the buyer.

### 5. Redeeming Fractions

Fraction holders can burn their tokens to receive a proportional share of the SOL held by the marketplace.

## Smart Contract Structure

- [`Marketplace`](lib.rs): Stores authority and treasury.
- [`ListedNFT`](lib.rs): Stores NFT details, pricing, supply, and reward info.
- **Core Instructions:**  
  - `initialize_marketplace`  
  - `list_nft`  
  - `buy_fraction`  
  - `sell_fraction`  
  - `buy_nft`  
  - `redeem_fractions`

See [lib.rs](lib.rs) for full program logic.

## Testing

Integration tests are provided in [test.ts](test.ts), covering:

- Marketplace initialization
- NFT listing
- Fractional trading (buy/sell)
- NFT buyout

## Getting Started

1. **Clone the repository**
2. **Install dependencies** (Anchor, Solana CLI, Node.js)
3. **Build and deploy the program** using Anchor
4. **Run tests**  
   ```sh
   anchor
