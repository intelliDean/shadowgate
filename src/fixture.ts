import assert from 'node:assert/strict';
import {address,lamports,getTransactionDecoder,createKeyPairSignerFromBytes} from '@solana/kit';
import {Keypair,TransactionMessage,VersionedTransaction,SystemProgram} from '@solana/web3.js';
import {MINT_SIZE,TOKEN_PROGRAM_ID,createInitializeMint2Instruction,getAssociatedTokenAddressSync,createAssociatedTokenAccountInstruction,createMintToInstruction,AccountLayout} from '@solana/spl-token';
import {FailedTransactionMetadata} from 'litesvm';
import {createLedger} from './ledger.js';

export async function createFixture(){
  const ledger=await createLedger();
  try {
    const feePayer=Keypair.generate(),payer=Keypair.generate(),merchant=Keypair.generate(),mint=Keypair.generate();
    const payerAta=getAssociatedTokenAddressSync(mint.publicKey,payer.publicKey), merchantAta=getAssociatedTokenAddressSync(mint.publicKey,merchant.publicKey);
    ledger.svm.airdrop(address(feePayer.publicKey.toBase58()),lamports(2_000_000_000n));
    const instructions=[
      SystemProgram.createAccount({fromPubkey:feePayer.publicKey,newAccountPubkey:mint.publicKey,lamports:Number(ledger.svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))),space:MINT_SIZE,programId:TOKEN_PROGRAM_ID}),
      createInitializeMint2Instruction(mint.publicKey,6,feePayer.publicKey,null),
      createAssociatedTokenAccountInstruction(feePayer.publicKey,payerAta,payer.publicKey,mint.publicKey),
      createAssociatedTokenAccountInstruction(feePayer.publicKey,merchantAta,merchant.publicKey,mint.publicKey),
      createMintToInstruction(mint.publicKey,payerAta,feePayer.publicKey,10_000n)
    ];
    const setup=new VersionedTransaction(new TransactionMessage({payerKey:feePayer.publicKey,recentBlockhash:ledger.svm.latestBlockhash(),instructions}).compileToV0Message());
    setup.sign([feePayer,mint]);
    const r=ledger.svm.sendTransaction(getTransactionDecoder().decode(setup.serialize()) as any);
    assert(!(r instanceof FailedTransactionMetadata),'SPL token fixture initialization failed');
    function balances(){
      const get=(key:typeof payerAta)=>{ const account=ledger.svm.getAccount(address(key.toBase58()));assert(account.exists);return AccountLayout.decode(Buffer.from(account.data)).amount.toString();};
      return {payer:get(payerAta),merchant:get(merchantAta),sponsorLamports:ledger.svm.getBalance(address(feePayer.publicKey.toBase58()))!.toString()};
    }
    return {ledger,feePayer,payer,merchant,mint,balances,payerSigner:await createKeyPairSignerFromBytes(payer.secretKey)};
  } catch(e){await ledger.close();throw e;}
}
