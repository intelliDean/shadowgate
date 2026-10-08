import { createServer, type ServerResponse } from "node:http";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import {
  address,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  signature,
} from "@solana/kit";

/**
 * Deliberately small HTTP/RPC transport over the real LiteSVM runtime.
 * It executes real signed SPL transactions. RPC confirmation below means
 * committed in this single-process SVM, not validator consensus/finality.
 * No remote RPC, faucets, production keys or real assets are involved.
 */
export async function createLedger() {
  const svm = new LiteSVM().withSigverify(true).withBlockhashCheck(true);
  const events: Array<Record<string, unknown>> = [];
  let dropNext = false;
  const counters = { requests: 0, sends: 0, executed: 0, simulations: 0, droppedResponses: 0 };
  const context = () => ({ slot: Number(svm.getClock().slot), apiVersion: "shadowgate-litesvm-1.5.0" });
  const withContext = (value: unknown) => ({ context: context(), value });
  const stringify = (data: unknown) => JSON.stringify(data, (_, v) => typeof v === "bigint" ? Number(v) : v);

  function accountInfo(pubkey: string, config: any = {}) {
    const account = svm.getAccount(address(pubkey));
    if (!account.exists) return null;
    let data = Buffer.from(account.data);
    if (config.dataSlice) data = data.subarray(config.dataSlice.offset, config.dataSlice.offset + config.dataSlice.length);
    return {
      data: [data.toString("base64"), "base64"], executable: account.executable,
      lamports: Number(account.lamports), owner: account.programAddress,
      rentEpoch: 0, space: account.data.length,
    };
  }

  function runtimeError(result: FailedTransactionMetadata) {
    const err = result.err();
    // Retain runtime text rather than inventing a JSON-RPC error classification.
    return { liteSvmError: typeof err === "object" ? String(err) : err, detail: result.toString() };
  }

  function transactionRecord(result: any, txSignature: string) {
    const failed = result instanceof FailedTransactionMetadata;
    const meta = failed ? result.meta() : result;
    return {
      signature: txSignature, err: failed ? runtimeError(result) : null,
      logs: meta.logs(), unitsConsumed: Number(meta.computeUnitsConsumed()),
      slot: Number(svm.getClock().slot), runtime: "LiteSVM 1.5.0",
    };
  }

  function txFromWire(wire: string) {
    return getTransactionDecoder().decode(Buffer.from(wire, "base64"));
  }

  function getWireSignature(tx: ReturnType<typeof txFromWire>) {
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const feePayer = compiled.staticAccounts[0];
    const bytes = tx.signatures[feePayer];
    if (!bytes) throw new Error("Missing fee-payer signature");
    return { txSignature: getBase58Decoder().decode(bytes), feePayer };
  }

  function dispatch(method: string, params: any[] = []) {
    switch (method) {
      case "getHealth": return "ok";
      case "getVersion": return { "solana-core": "litesvm-1.5.0", "feature-set": 0 };
      case "getSlot": return Number(svm.getClock().slot);
      case "getBlockHeight": return Number(svm.getClock().slot);
      case "getLatestBlockhash": return withContext({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: Number(svm.getClock().slot) + 150 });
      case "isBlockhashValid": return withContext(params[0] === svm.latestBlockhash());
      case "getBalance": return withContext(Number(svm.getBalance(address(params[0])) ?? 0n));
      case "getAccountInfo": return withContext(accountInfo(params[0], params[1]));
      case "getMultipleAccounts": return withContext(params[0].map((key: string) => accountInfo(key, params[1])));
      case "getMinimumBalanceForRentExemption": return Number(svm.minimumBalanceForRentExemption(BigInt(params[0])));
      case "getTokenAccountBalance": {
        const account = svm.getAccount(address(params[0]));
        if (!account.exists || account.data.length < 72) throw new Error("Token account does not exist");
        const data = Buffer.from(account.data);
        const amount = data.readBigUInt64LE(64);
        const mint = getBase58Decoder().decode(data.subarray(0, 32));
        const mintAccount = svm.getAccount(address(mint));
        if (!mintAccount.exists) throw new Error("Token mint does not exist");
        const decimals = mintAccount.data[44];
        return withContext({ amount: amount.toString(), decimals, uiAmount: Number(amount) / 10 ** decimals, uiAmountString: String(Number(amount) / 10 ** decimals) });
      }
      case "getSignatureStatuses": return withContext(params[0].map((sig: string) => {
        const result = svm.getTransaction(signature(sig));
        if (!result) return null;
        return { slot: Number(svm.getClock().slot), confirmations: 1, err: result instanceof FailedTransactionMetadata ? runtimeError(result) : null, confirmationStatus: "confirmed" };
      }));
      case "getFeeForMessage": {
        const message = getCompiledTransactionMessageDecoder().decode(Buffer.from(params[0], "base64"));
        // Exact fee estimation is not used by the spike. Reject rather than
        // fabricate a fee estimate lacking the active runtime fee schedule.
        throw new Error(`getFeeForMessage is outside this bridge's supported methods (${message.header.numSignerAccounts} signers); observe actual fee-payer balance changes`);
      }
      case "simulateTransaction": {
        counters.simulations++;
        const config = params[1] ?? {};
        if (config.replaceRecentBlockhash) throw new Error("replaceRecentBlockhash is not implemented in this narrow bridge");
        const tx = txFromWire(params[0]);
        svm.withSigverify(config.sigVerify ?? false);
        try {
          const result = svm.simulateTransaction(tx);
          const failed = result instanceof FailedTransactionMetadata;
          const meta = result.meta();
          events.push({ event: "simulate", sigVerify: config.sigVerify ?? false, err: failed ? runtimeError(result) : null, unitsConsumed: Number(meta.computeUnitsConsumed()) });
          return withContext({ err: failed ? runtimeError(result) : null, logs: meta.logs(), unitsConsumed: Number(meta.computeUnitsConsumed()), returnData: null, accounts: null, innerInstructions: null });
        } finally { svm.withSigverify(true); }
      }
      case "sendTransaction": {
        counters.sends++;
        const tx = txFromWire(params[0]);
        const { txSignature, feePayer } = getWireSignature(tx);
        const before = svm.getBalance(feePayer) ?? 0n;
        const existing = svm.getTransaction(signature(txSignature));
        // Solana RPC accepts repeated identical successful submissions;
        // LiteSVM transaction history establishes whether it already executed.
        const result = existing && !(existing instanceof FailedTransactionMetadata) ? existing : svm.sendTransaction(tx);
        const reused = result === existing;
        if (!reused) counters.executed++;
        const record = transactionRecord(result, txSignature);
        events.push({ event: "send", ...record, reused, feePayer, feePayerLamportsBefore: before.toString(), feePayerLamportsAfter: (svm.getBalance(feePayer) ?? 0n).toString(), feePayerLamportsDelta: (before - (svm.getBalance(feePayer) ?? 0n)).toString() });
        if (result instanceof FailedTransactionMetadata) throw Object.assign(new Error(result.toString()), { rpcData: record });
        if (dropNext) {
          dropNext = false;
          counters.droppedResponses++;
          events.push({ event: "drop-send-response-after-runtime-success", signature: txSignature, ...counters });
          return DROP_RESPONSE;
        }
        return txSignature;
      }
      default: throw new Error(`Unsupported RPC method: ${method}`);
    }
  }

  const DROP_RESPONSE = Symbol("drop-response");
  const server = createServer(async (req, res: ServerResponse) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      counters.requests++;
      let result;
      try { result = dispatch(body.method, body.params); }
      catch (error: any) {
        events.push({ event: "rpc-error", method: body.method, error: error.message });
        res.setHeader("content-type", "application/json");
        res.end(stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32002, message: error.message, data: error.rpcData } }));
        return;
      }
      if (result === DROP_RESPONSE) { req.socket.destroy(); return; }
      res.setHeader("content-type", "application/json");
      res.end(stringify({ jsonrpc: "2.0", id: body.id, result }));
    } catch (error: any) {
      res.statusCode = 400;
      res.end(stringify({ error: error.message }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("No local RPC port");
  return {
    svm, url: `http://127.0.0.1:${bound.port}`, events, counters,
    dropNextSendResponse() { dropNext = true; },
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }),
  };
}
