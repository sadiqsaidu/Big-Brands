// not complete tests still requires refactoring

import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccount,
} from "@solana/spl-token";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import assert from "assert";

describe("brand-nft-marketplace", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.BrandNftMarketplace;

  let marketplacePDA;
  let buyer;

  before(async () => {
    // Find the marketplace PDA
    [marketplacePDA] = await PublicKey.findProgramAddress(
      [Buffer.from("marketplace")],
      program.programId
    );

    // Create a buyer account that we'll use throughout the tests
    buyer = anchor.web3.Keypair.generate();

    // Fund the buyer account
    await fundAccount(buyer.publicKey, 10); // Fund with 10 SOL
  });

  // Helper function to fund accounts without relying on airdrops
  async function fundAccount(publicKey, amount) {
    const transferTx = await provider.connection.requestAirdrop(
      publicKey,
      amount * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(transferTx);
    console.log(`Funded ${publicKey.toString()} with ${amount} SOL`);
  }

  it("Lists an NFT in the marketplace", async () => {
    const owner = anchor.web3.Keypair.generate();
    await fundAccount(owner.publicKey, 5); // Fund with 5 SOL

    const nftMint = await createMint(
      provider.connection,
      owner,
      owner.publicKey,
      null,
      0
    );

    const ownerNftAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      nftMint,
      owner.publicKey
    );

    await mintTo(
      provider.connection,
      owner,
      nftMint,
      ownerNftAccount,
      owner,
      1
    );

    const [escrowPDA] = await PublicKey.findProgramAddress(
      [Buffer.from("escrow"), nftMint.toBuffer()],
      program.programId
    );

    const fractionMint = await createMint(
      provider.connection,
      owner,
      marketplacePDA,
      null,
      0
    );

    const ownerFractionAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      fractionMint,
      owner.publicKey
    );

    const communityRewardAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      fractionMint,
      owner.publicKey
    );

    try {
      const tx = await program.methods
        .listNft(new anchor.BN(1000000), new anchor.BN(1000), 5)
        .accounts({
          owner: owner.publicKey,
          nftMint: nftMint,
          ownerNftAccount: ownerNftAccount,
          escrowAccount: escrowPDA,
          fractionMint: fractionMint,
          ownerFractionAccount: ownerFractionAccount,
          communityRewardAccount: communityRewardAccount,
          marketplace: marketplacePDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([owner])
        .rpc();

      console.log("NFT listed successfully. Transaction signature:", tx);

      const listedNftAccounts = await program.account.listedNFT.all([
        {
          memcmp: {
            offset: 8,
            bytes: owner.publicKey.toBase58(),
          },
        },
      ]);

      assert.strictEqual(listedNftAccounts.length, 1, "NFT listing not found");
      const listedNft = listedNftAccounts[0].account;

      assert.strictEqual(
        listedNft.owner.toString(),
        owner.publicKey.toString(),
        "Incorrect owner"
      );
      assert.strictEqual(
        listedNft.nftMint.toString(),
        nftMint.toString(),
        "Incorrect NFT mint"
      );
      assert.strictEqual(
        listedNft.fractionMint.toString(),
        fractionMint.toString(),
        "Incorrect fraction mint"
      );
      assert.strictEqual(
        listedNft.initialPrice.toString(),
        "1000000",
        "Incorrect initial price"
      );
      assert.strictEqual(
        listedNft.fractionSupply.toString(),
        "1000",
        "Incorrect fraction supply"
      );
      assert.strictEqual(
        listedNft.communityRewardPercentage,
        5,
        "Incorrect community reward percentage"
      );

      console.log("NFT listing verified successfully");
    } catch (error) {
      console.error("Error listing NFT:", error);
      throw error;
    }
  });

  it("Buys fractions of a listed NFT", async () => {
    // Fetch the listed NFT account
    const listedNftAccounts = await program.account.listedNFT.all();
    assert(listedNftAccounts.length > 0, "No listed NFTs found");
    const listedNft = listedNftAccounts[0];

    // Create buyer's fraction token account
    const buyerFractionAccount = await createAssociatedTokenAccount(
      provider.connection,
      buyer,
      listedNft.account.fractionMint,
      buyer.publicKey
    );

    // Fetch the fraction treasury account
    const fractionTreasury = await getAssociatedTokenAddress(
      listedNft.account.fractionMint,
      marketplacePDA,
      true
    );

    try {
      const amountToBuy = new anchor.BN(100); // Buy 100 fraction tokens
      const tx = await program.methods
        .buyFraction(amountToBuy)
        .accounts({
          buyer: buyer.publicKey,
          seller: listedNft.account.owner,
          listedNft: listedNft.publicKey,
          fractionTreasury: fractionTreasury,
          buyerFractionAccount: buyerFractionAccount,
          marketplace: marketplacePDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      console.log("Fractions bought successfully. Transaction signature:", tx);

      // Verify the buyer received the fraction tokens
      const buyerAccount = await getAccount(
        provider.connection,
        buyerFractionAccount
      );
      assert.strictEqual(
        buyerAccount.amount.toString(),
        amountToBuy.toString(),
        "Buyer did not receive correct amount of fraction tokens"
      );

      // Verify the listed NFT's current price has been updated
      const updatedListedNft = await program.account.listedNFT.fetch(
        listedNft.publicKey
      );
      assert(
        updatedListedNft.currentPrice.gt(listedNft.account.currentPrice),
        "Current price should have increased after purchase"
      );
    } catch (error) {
      console.error("Error buying fractions:", error);
      throw error;
    }
  });

  it("Sells fractions of a listed NFT", async () => {
    // Fetch the listed NFT account again
    const listedNftAccounts = await program.account.listedNFT.all();
    const listedNft = listedNftAccounts[0];

    // Get seller's fraction token account
    const sellerFractionAccount = await getAssociatedTokenAddress(
      listedNft.account.fractionMint,
      buyer.publicKey
    );

    // Fetch the fraction treasury account
    const fractionTreasury = await getAssociatedTokenAddress(
      listedNft.account.fractionMint,
      marketplacePDA,
      true
    );

    try {
      const amountToSell = new anchor.BN(50); // Sell 50 fraction tokens
      const tx = await program.methods
        .sellFraction(amountToSell)
        .accounts({
          seller: buyer.publicKey,
          listedNft: listedNft.publicKey,
          sellerFractionAccount: sellerFractionAccount,
          fractionTreasury: fractionTreasury,
          marketplace: marketplacePDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      console.log("Fractions sold successfully. Transaction signature:", tx);

      // Verify the seller's fraction token balance decreased
      const sellerAccount = await getAccount(
        provider.connection,
        sellerFractionAccount
      );
      assert.strictEqual(
        sellerAccount.amount.toString(),
        "50",
        "Seller's fraction token balance is incorrect"
      );

      // Verify the listed NFT's current price has been updated
      const updatedListedNft = await program.account.listedNFT.fetch(
        listedNft.publicKey
      );
      assert(
        updatedListedNft.currentPrice.lt(listedNft.account.currentPrice),
        "Current price should have decreased after sale"
      );
    } catch (error) {
      console.error("Error selling fractions:", error);
      throw error;
    }
  });

  it("Buys the entire NFT", async () => {
    // Create buyer's NFT token account
    const buyerNftAccount = await createAssociatedTokenAccount(
      provider.connection,
      buyer,
      nftMint,
      buyer.publicKey
    );

    // Get the initial balances
    const initialBuyerBalance = await provider.connection.getBalance(
      buyer.publicKey
    );
    const initialMarketplaceBalance = await provider.connection.getBalance(
      marketplacePDA
    );

    try {
      const tx = await program.methods
        .buyNft()
        .accounts({
          buyer: buyer.publicKey,
          listedNft: listedNft.publicKey,
          escrowAccount: escrowAccount,
          buyerNftAccount: buyerNftAccount,
          marketplace: marketplacePDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      console.log("NFT bought successfully. Transaction signature:", tx);

      // Verify the NFT was transferred to the buyer
      const buyerNftAccountInfo = await getAccount(
        provider.connection,
        buyerNftAccount
      );
      assert.strictEqual(
        buyerNftAccountInfo.amount.toString(),
        "1",
        "Buyer did not receive the NFT"
      );

      // Verify the listed NFT's owner has been updated
      const updatedListedNft = await program.account.listedNFT.fetch(
        listedNft.publicKey
      );
      assert.strictEqual(
        updatedListedNft.owner.toString(),
        buyer.publicKey.toString(),
        "Listed NFT owner not updated"
      );

      // Verify the SOL transfer
      const finalBuyerBalance = await provider.connection.getBalance(
        buyer.publicKey
      );
      const finalMarketplaceBalance = await provider.connection.getBalance(
        marketplacePDA
      );

      assert(
        finalBuyerBalance < initialBuyerBalance,
        "Buyer's balance did not decrease"
      );
      assert(
        finalMarketplaceBalance > initialMarketplaceBalance,
        "Marketplace balance did not increase"
      );
    } catch (error) {
      console.error("Error buying NFT:", error);
      throw error;
    }
  });

  it("Redeems fractions for SOL", async () => {
    // Create a new account to hold fractions
    const fractionHolder = anchor.web3.Keypair.generate();
    await fundAccount(fractionHolder.publicKey, 1); // Fund with 1 SOL for transaction fees

    // Create fraction token account for the holder
    const holderFractionAccount = await createAssociatedTokenAccount(
      provider.connection,
      fractionHolder,
      fractionMint,
      fractionHolder.publicKey
    );

    // Mint some fraction tokens to the holder (assuming we have permission to do so)
    const amountToMint = 100; // Mint 100 fraction tokens
    await mintTo(
      provider.connection,
      owner,
      fractionMint,
      holderFractionAccount,
      marketplacePDA,
      amountToMint
    );

    // Get initial balances
    const initialHolderBalance = await provider.connection.getBalance(
      fractionHolder.publicKey
    );
    const initialMarketplaceBalance = await provider.connection.getBalance(
      marketplacePDA
    );

    try {
      const tx = await program.methods
        .redeemFractions()
        .accounts({
          tokenHolder: fractionHolder.publicKey,
          listedNft: listedNft.publicKey,
          fractionMint: fractionMint,
          holderFractionAccount: holderFractionAccount,
          marketplace: marketplacePDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([fractionHolder])
        .rpc();

      console.log(
        "Fractions redeemed successfully. Transaction signature:",
        tx
      );

      // Verify the fraction tokens were burned
      const finalHolderFractionAccount = await getAccount(
        provider.connection,
        holderFractionAccount
      );
      assert.strictEqual(
        finalHolderFractionAccount.amount.toString(),
        "0",
        "Fraction tokens were not burned"
      );

      // Verify the SOL transfer
      const finalHolderBalance = await provider.connection.getBalance(
        fractionHolder.publicKey
      );
      const finalMarketplaceBalance = await provider.connection.getBalance(
        marketplacePDA
      );

      assert(
        finalHolderBalance > initialHolderBalance,
        "Holder's balance did not increase"
      );
      assert(
        finalMarketplaceBalance < initialMarketplaceBalance,
        "Marketplace balance did not decrease"
      );
    } catch (error) {
      console.error("Error redeeming fractions:", error);
      throw error;
    }
  });
});
