// i hate js
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddress,
  getAccount,
} from "@solana/spl-token";

import { LAMPORTS_PER_SOL, Transaction, SystemProgram } from "@solana/web3.js";

describe("brand-nft-marketplace", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.BrandNftMarketplace;

  let marketplacePDA;
  let buyer;
  let nftMint;
  let fractionMint;
  let escrowAccount;
  let owner;
  let authority;
  let treasury;
  let funderAccount;

  before(async () => {
    // funder account that will recieve the initial airdrop
    funderAccount = anchor.web3.Keypair.generate();

    await fundAccount(funderAccount.publicKey, 3);

    authority = provider.wallet.publicKey;
    treasury = anchor.web3.Keypair.generate();

    owner = await createAndFundAccount(1);
    buyer = await createAndFundAccount(1);

    [marketplacePDA] = await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from("marketplace")],
      program.programId
    );

    console.log("Marketplace Authority: ", authority.toString());
    console.log("Treasury: ", treasury.publicKey.toString());
    console.log("Marketplace PDA: ", marketplacePDA.toString());
    console.log("Owner of NFT: ", owner.publicKey.toString());
    console.log("Buyer of NFT: ", buyer.publicKey.toString());
  });

  // helper function to fund funder account
  async function fundAccount(publicKey, amount) {
    const tx = await provider.connection.requestAirdrop(
      publicKey,
      amount * LAMPORTS_PER_SOL
    );

    await provider.connection.confirmTransaction(tx);
    console.log(`Funded ${publicKey.toString()} with ${amount} SOL`);
  }

  // helper function to create new account and fund it
  async function createAndFundAccount(amount) {
    const newAccount = anchor.web3.Keypair.generate();

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: funderAccount.publicKey,
        toPubkey: newAccount.publicKey,
        lamports: amount * LAMPORTS_PER_SOL,
      })
    );

    await provider.sendAndConfirm(tx, [funderAccount]);
    console.log(
      `Created and funded ${newAccount.publicKey.toString()} with ${amount} SOL`
    );

    return newAccount;
  }

  // test for initializing the marketplace
  it("Initalizes the marketplace", async () => {
    const accountInfo = await provider.connection.getAccountInfo(
      marketplacePDA
    );

    if (!accountInfo) {
      console.log("Marketplace account doesn't exist. Initializing...");
      await program.methods
        .initializeMarketplace()
        .accounts({
          authority: authority,
          marketplace: marketplacePDA,
          treasury: treasury.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      console.log("Marketplace initialized successfully");
    } else {
      console.log(
        "Marketplace account already exists. Skipping initialization."
      );
    }

    const marketplaceAccount = await program.account.marketplace.fetch(
      marketplacePDA
    );

    assert.strictEqual(
      marketplaceAccount.authority.toString(),
      authority.publicKey.toString(),
      "Incorrect marketplace authority"
    );

    assert.strictEqual(
      marketplaceAccount.treasury.toString(),
      treasury.publicKey.toString(),
      "Incorrect marketplace treasury"
    );
  });

  // test for listing NFT by owner
  it("Lists and NFT in the marketplace", async () => {
    // create NFT mint and associated accounts
    nftMint = await createMint(
      provider.connection,
      owner,
      owner.publicKey,
      null,
      0
    );

    // owner nft account
    const ownerNftAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      nftMint,
      owner.publicKey
    );

    // mint nft to owner
    await mintTo(
      provider.connection,
      owner,
      nftMint,
      ownerNftAccount,
      owner,
      1
    );

    // escrow account from the of the marketplace for the nft
    [escrowAccount] = await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from("escrow"), nftMint.toBuffer()],
      program.programId
    );

    // fractional tokens mint
    fractionMint = await createMint(
      provider.connection,
      owner,
      marketplacePDA,
      null,
      0
    );

    // owner fractional tokens account
    const ownerFractionAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      fractionMint,
      owner.publicKey
    );

    // community reward token account of fractional mint
    const communityRewardAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      fractionMint,
      owner.publicKey
    );

    // after all that wahala now list nft
    const tx = await program.methods
      .listNft(new anchor.BN(1000000), new anchor.BN(1000), 5)
      .accounts({
        owner: owner.publicKey,
        nftMint: nftMint,
        ownerNftAccount: ownerNftAccount,
        escrowAccount: escrowAccount,
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

    console.log("NFT listed successfully. Transaction signature: ", tx);

    // fetch listed nft from nft state account
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
  });

  // tests for buying fraction tokens of a listed nft
  it("Buys fractions of a listed NFT", async () => {
    // fetch the listed nft account
    const listedNftAccounts = await program.account.listedNFT.all();
    assert(listedNftAccounts.length > 0, "No listed NFTs found");
    const listedNft = listedNftAccounts[0];

    // buyers fractional token account
    const buyerFractionAccount = await createAssociatedTokenAccount(
      provider.connection,
      buyer,
      listedNft.account.fractionMint,
      buyer.publicKey
    );

    // fetch the fractional treasury account
    const fractionTreasury = await getAssociatedTokenAddress(
      listedNft.account.fractionMint,
      marketplacePDA,
      true
    );

    // buy 100 fraction tokens
    try {
      const amountToBuy = new anchor.BN(100);
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

      // check the buyer received fraction tokens
      const buyerAccount = await getAccount(
        provider.connection,
        buyerFractionAccount
      );

      assert.strictEqual(
        buyerAccount.amount.toString(),
        amountToBuy.toString(),
        "Buyer did not receive correct amount of fraction tokens"
      );

      // check that the listed nft's current price has updated
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

  // test for selling fractional tokens of listed nft
  it("Sells fractions of a listed NFT", async () => {
    // fetch the listed nft state account
    const listedNftAccounts = await program.account.listedNFT.all();
    const listedNft = listedNftAccounts[0];

    // i don tire guy

    // get seller's fraction token account
    const sellerFractionAccount = await getAssociatedTokenAddress(
      listedNft.account.fractionMint,
      buyer.publicKey
    );

    // get the fraction treasury account
    const fractionTreasury = await getAssociatedTokenAddress(
      listedNft.account.fractionMint,
      marketplacePDA,
      true
    );

    // sells 100 fractional tokens
    try {
      const amountToSell = new anchor.BN(100);
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

      // check that the seller's fractino token balance decreases
      const sellerAccount = await getAccount(
        provider.connection,
        sellerFractionAccount
      );

      assert.strictEqual(
        sellerAccount.amount.toString(),
        "100",
        "Seller's fraction token balance is incorrect"
      );

      // check that the listed nft current price has updated
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

  // test for buying entire nft
  it("Buys the entire NFT", async () => {
    // fetch the listed nft state account
    const listedNftAccounts = await program.account.listedNFT.all();
    const listedNft = listedNftAccounts[0];

    // create buyer nft token account
    const buyerNftAccount = await createAssociatedTokenAccount(
      provider.connection,
      buyer,
      nftMint,
      buyer.publicKey
    );

    // get the initial balances
    const initialBuyerBalance = await provider.connection.getBalance(
      buyer.publicKey
    );

    const initialMarketplaceBalance = await provider.connection.getBalance(
      marketplacePDA
    );

    // buy the entire nft
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

      // check the nft ownership is now the buyer
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
});
