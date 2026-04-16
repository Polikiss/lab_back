import express from "express";
import { ethers } from "ethers";
import * as StellarSdk from "@stellar/stellar-sdk";
import pino from "pino";
import {
  CONFIG,
  assertConfig,
  isBridgeVoteCreditEnabled,
  isReverseEvmMintEnabled,
  resolveStellarOracleSecret,
  stellarMintAmountFromEvmLock
} from "./config.js";
import { MemoryStore, ReverseMintStore } from "./memoryStore.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const store = new MemoryStore();
const reverseStore = new ReverseMintStore();

const VOTE_TOKEN_ABI = [
  "event Locked(address indexed user, uint256 amount, string stellarDestination)"
];

const VOTE_TOKEN_WITH_EVM_MINT_ABI = [
  ...VOTE_TOKEN_ABI,
  "function mintFromStellar(address to, uint256 amount, bytes32 stellarLockId) external"
];

const BRIDGE_CREDIT_ABI = [
  "function recordBridgedLock(address user, uint256 amount, bytes32 lockId)"
];

function lockIdForTask(evmTxHash: string, logIndex: number): string {
  return ethers.keccak256(
    ethers.solidityPacked(["bytes32", "uint256"], [evmTxHash, BigInt(logIndex)])
  );
}

async function recordBridgedVoteCredit(
  provider: ethers.JsonRpcProvider,
  task: import("./memoryStore.js").BridgeTaskRecord,
  creditAmountWei: string
): Promise<{ txHash: string | null; error: string | null }> {
  if (!isBridgeVoteCreditEnabled()) {
    return { txHash: null, error: null };
  }
  try {
    const lockId = lockIdForTask(task.evmTxHash, task.logIndex);
    const wallet = new ethers.Wallet(CONFIG.ORACLE_EVM_PRIVATE_KEY, provider);
    const credit = new ethers.Contract(
      ethers.getAddress(CONFIG.BRIDGE_VOTE_CREDIT_ADDRESS),
      BRIDGE_CREDIT_ABI,
      wallet
    );
    const tx = await credit.recordBridgedLock(
      ethers.getAddress(task.user),
      creditAmountWei,
      lockId
    );
    const receipt = await tx.wait();
    const h = receipt?.hash ?? null;
    return { txHash: h, error: null };
  } catch (e: unknown) {
    const err = String((e as Error)?.message ?? e).slice(0, 255);
    return { txHash: null, error: err };
  }
}

let oracleMintKeypair: StellarSdk.Keypair | null = null;
function getOracleMintKeypair(): StellarSdk.Keypair {
  if (!oracleMintKeypair) {
    const raw = resolveStellarOracleSecret().trim();
    try {
      oracleMintKeypair = StellarSdk.Keypair.fromSecret(raw);
    } catch (e: unknown) {
      const base = String((e as Error)?.message ?? e);
      const hint =
        /invalid encoded string/i.test(base) && !CONFIG.STELLAR_ORACLE_SOURCE
          ? " Проверьте STELLAR_ORACLE_SECRET: один корректный S-ключ (56 символов после S), без кавычек, пробелов и переносов строк в Variables."
          : CONFIG.STELLAR_ORACLE_SOURCE
            ? " Проверьте STELLAR_ORACLE_SOURCE / вывод stellar keys show."
            : "";
      throw new Error(`${base}${hint}`);
    }
  }
  return oracleMintKeypair;
}

/** Мягкий getTransaction для обратного моста: нет status → null, not found → null. */
async function rpcGetSorobanTxStatus(
  rpcUrl: string,
  hash: string
): Promise<string | null> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: { hash }
    })
  });
  const json: unknown = await res.json();
  const j = json as { error?: { message?: string }; result?: { status?: string } };
  if (j.error) {
    const m = j.error.message ?? "";
    if (/not found|NOT_FOUND|Missing|missing/i.test(m)) return null;
    throw new Error(`Soroban RPC getTransaction: ${m || JSON.stringify(j.error)}`);
  }
  const status = j.result?.status;
  if (!status) return null;
  return status;
}

function normalizeStellarTxHashForRpc(h: string): string {
  const x = h.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(x)) {
    throw new Error(
      "stellarTxHash: нужен 64 hex-символа (32 байта), хеш Soroban-транзакции"
    );
  }
  return x;
}

function normalizeStellarTxHash0x(h: string): string {
  return `0x${normalizeStellarTxHashForRpc(h)}`;
}

async function waitSorobanTxSuccess(rpcUrl: string, stellarTxHash0x: string): Promise<void> {
  const raw = normalizeStellarTxHashForRpc(stellarTxHash0x);
  const candidates = [raw, `0x${raw}`];
  const maxAttempts = 40;
  for (let i = 0; i < maxAttempts; i++) {
    for (const hash of candidates) {
      const st = await rpcGetSorobanTxStatus(rpcUrl, hash);
      if (st === "SUCCESS") {
        return;
      }
      if (st === "FAILED") {
        throw new Error("Stellar transaction FAILED (проверьте обозреватель / логи контракта)");
      }
    }
    if (i === maxAttempts - 1) {
      throw new Error(
        "Таймаут ожидания SUCCESS по Stellar tx (проверьте хеш и сеть Soroban testnet)"
      );
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** Только статус tx из Soroban RPC без разбора XDR (избегаем рассинхрона stellar-base с новыми вариантами union в meta). */
async function rpcGetTransactionStatus(
  rpcUrl: string,
  hash: string
): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: { hash }
    })
  });
  const json: unknown = await res.json();
  const err = json as { error?: { message?: string } };
  if (err && typeof err === "object" && err.error) {
    throw new Error(
      `Soroban RPC getTransaction: ${err.error.message ?? JSON.stringify(err.error)}`
    );
  }
  const result = json as { result?: { status?: string } };
  const status = result.result?.status;
  if (!status) {
    throw new Error(
      `Soroban RPC getTransaction: нет status, ответ: ${JSON.stringify(json).slice(0, 400)}`
    );
  }
  return status;
}

async function sorobanMint(destinationStr: string, amountBn: bigint): Promise<string> {
  const kp = getOracleMintKeypair();
  const server = new StellarSdk.rpc.Server(CONFIG.STELLAR_RPC_URL);
  const source = await server.getAccount(kp.publicKey());
  let contract: StellarSdk.Contract;
  try {
    contract = new StellarSdk.Contract(CONFIG.STELLAR_WRAPPER_CONTRACT_ID);
  } catch (e: unknown) {
    throw new Error(
      `STELLAR_WRAPPER_CONTRACT_ID: ${String((e as Error)?.message ?? e)}`
    );
  }

  if (
    amountBn > BigInt("170141183460469231731687303715884105727") ||
    amountBn < 0n
  ) {
    throw new Error("Amount does not fit i128 (Soroban)");
  }

  let dest: StellarSdk.Address;
  try {
    dest = new StellarSdk.Address(destinationStr.trim());
  } catch (e: unknown) {
    throw new Error(
      `stellarDestination (получатель mint): ${String((e as Error)?.message ?? e)}`
    );
  }
  logger.info(
    {
      contract: CONFIG.STELLAR_WRAPPER_CONTRACT_ID,
      oraclePublic: kp.publicKey(),
      destination: destinationStr.trim(),
      amount: amountBn.toString()
    },
    "[stellar] mint invoke"
  );
  const op = contract.call(
    "mint",
    dest.toScVal(),
    StellarSdk.nativeToScVal(amountBn, { type: "i128" })
  );

  let tx = new StellarSdk.TransactionBuilder(source, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: CONFIG.STELLAR_NETWORK_PASSPHRASE
  })
    .addOperation(op)
    .setTimeout(180)
    .build();

  tx.sign(kp);
  const prepped = await server.prepareTransaction(tx);
  prepped.sign(kp);
  const send = await server.sendTransaction(prepped);
  if (send.status === "ERROR") {
    throw new Error(`Stellar sendTransaction: ${JSON.stringify(send)}`);
  }

  const hash = send.hash;
  logger.info({ hash, status: send.status }, "[stellar] sendTransaction");

  for (;;) {
    const st = await rpcGetTransactionStatus(CONFIG.STELLAR_RPC_URL, hash);
    if (st === "SUCCESS") {
      logger.info("[stellar] transaction SUCCESS");
      return hash;
    }
    if (st === "FAILED") {
      throw new Error(
        `Stellar tx FAILED (hash ${hash}). Подробности: обозреватель Stellar / повторный getTransaction в CLI.`
      );
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
}

async function processTask(
  taskId: number,
  provider: ethers.JsonRpcProvider
): Promise<void> {
  const task = store.findById(taskId);
  if (!task || task.status === "SUCCESS") return;

  store.update(taskId, { status: "PROCESSING", error: null });

  try {
    logger.info(
      { taskId, evmTxHash: task.evmTxHash },
      "[oracle] waiting confirmations"
    );
    await provider.waitForTransaction(task.evmTxHash, CONFIG.CONFIRMATIONS);

    const evmLocked = BigInt(task.amount);
    const stellarMintAmt = stellarMintAmountFromEvmLock(evmLocked);
    if (stellarMintAmt === 0n) {
      throw new Error(
        `Сумма lock на EVM слишком мала: после /${CONFIG.EVM_TO_STELLAR_AMOUNT_DIVISOR} для Soroban mint получается 0`
      );
    }
    logger.info(
      {
        taskId,
        evmLocked: task.amount,
        stellarMint: stellarMintAmt.toString(),
        divisor: CONFIG.EVM_TO_STELLAR_AMOUNT_DIVISOR.toString()
      },
      "[bridge] EVM→Stellar amount scale"
    );

    const stellarHash = await sorobanMint(task.stellarDestination, stellarMintAmt);

    const creditResult = await recordBridgedVoteCredit(
      provider,
      task,
      stellarMintAmt.toString()
    );
    if (creditResult.txHash) {
      logger.info(
        { taskId, evmCreditTxHash: creditResult.txHash },
        "[evm] BridgeVoteCredit OK"
      );
    } else if (creditResult.error) {
      logger.warn(
        { taskId, evmCreditError: creditResult.error },
        "[evm] BridgeVoteCredit skipped or failed"
      );
    }

    store.update(taskId, {
      status: "SUCCESS",
      stellarTxHash: stellarHash,
      error: null,
      evmCreditTxHash: creditResult.txHash,
      evmCreditError: creditResult.error
    });
    logger.info({ taskId, stellarHash }, "Task SUCCESS");
  } catch (e: unknown) {
    const msg = String((e as Error)?.message ?? e).slice(0, 255);
    logger.error({ taskId, error: msg }, "Task FAILED");
    store.update(taskId, { status: "FAILED", error: msg });
  }
}

async function recoverPendingTasks(provider: ethers.JsonRpcProvider): Promise<void> {
  const stuck = store.listStuck();
  logger.info({ count: stuck.length }, "recover tasks");
  for (const t of stuck) {
    await processTask(t.id, provider);
  }
}

async function processReverseMintTask(
  taskId: number,
  provider: ethers.JsonRpcProvider
): Promise<void> {
  const task = reverseStore.findById(taskId);
  if (!task || task.status === "SUCCESS") return;

  reverseStore.update(taskId, { status: "PROCESSING", error: null });

  try {
    await waitSorobanTxSuccess(CONFIG.STELLAR_RPC_URL, task.stellarTxHash);

    const wallet = new ethers.Wallet(CONFIG.ORACLE_EVM_PRIVATE_KEY, provider);
    const token = new ethers.Contract(
      CONFIG.VOTE_TOKEN_ADDRESS,
      VOTE_TOKEN_WITH_EVM_MINT_ABI,
      wallet
    );
    const lockId = task.stellarTxHash as `0x${string}`;
    const tx = await token.mintFromStellar(task.evmRecipient, task.amount, lockId);
    const receipt = await tx.wait();
    const evmHash = receipt?.hash ?? null;
    reverseStore.update(taskId, {
      status: "SUCCESS",
      evmMintTxHash: evmHash,
      error: null
    });
    logger.info({ taskId, evmHash }, "[reverse] mintFromStellar OK");
  } catch (e: unknown) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    logger.error({ taskId, error: msg }, "[reverse] mint FAILED");
    reverseStore.update(taskId, { status: "FAILED", error: msg });
  }
}

async function recoverPendingReverse(provider: ethers.JsonRpcProvider): Promise<void> {
  if (!isReverseEvmMintEnabled()) return;
  const stuck = reverseStore.listStuck();
  logger.info({ count: stuck.length }, "recover reverse mint tasks");
  for (const t of stuck) {
    await processReverseMintTask(t.id, provider);
  }
}

function taskToJson(t: import("./memoryStore.js").BridgeTaskRecord) {
  return {
    id: t.id,
    evmTxHash: t.evmTxHash,
    logIndex: t.logIndex,
    user: t.user,
    amount: t.amount,
    stellarDestination: t.stellarDestination,
    status: t.status,
    stellarTxHash: t.stellarTxHash,
    error: t.error,
    evmCreditTxHash: t.evmCreditTxHash,
    evmCreditError: t.evmCreditError,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString()
  };
}

function reverseTaskToJson(t: import("./memoryStore.js").ReverseMintRecord) {
  return {
    id: t.id,
    stellarTxHash: t.stellarTxHash,
    evmRecipient: t.evmRecipient,
    amount: t.amount,
    status: t.status,
    evmMintTxHash: t.evmMintTxHash,
    error: t.error,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString()
  };
}

const EVM_LOG_POLL_MS = Number(process.env.EVM_LOG_POLL_MS ?? "8000");

async function handleLockedLog(
  log: ethers.EventLog,
  provider: ethers.JsonRpcProvider
): Promise<void> {
  const user = log.args[0] as string;
  const amount = log.args[1] as bigint;
  const stellarDestination = log.args[2] as string;
  const txHash = log.transactionHash;
  const logIndex = log.index;

  try {
    const existing = store.findByEvmKey(txHash, logIndex);

    if (existing) {
      if (existing.status === "SUCCESS") {
        logger.info({ txHash, logIndex }, "duplicate Locked event, already SUCCESS");
        return;
      }
      logger.info({ taskId: existing.id }, "re-processing existing task");
      await processTask(existing.id, provider);
      return;
    }

    const task = store.create({
      evmTxHash: txHash,
      logIndex,
      user,
      amount: amount.toString(),
      stellarDestination,
      status: "PENDING",
      stellarTxHash: null,
      error: null,
      evmCreditTxHash: null,
      evmCreditError: null
    });

    logger.info(
      {
        taskId: task.id,
        txHash,
        amount: amount.toString(),
        stellarDestination
      },
      "[evm] Locked → new BridgeTask"
    );

    await processTask(task.id, provider);
  } catch (e) {
    logger.error(e, "[error] Locked handler");
  }
}

async function main(): Promise<void> {
  assertConfig();

  const provider = new ethers.JsonRpcProvider(CONFIG.EVM_RPC_URL);
  const tokenAddr = CONFIG.VOTE_TOKEN_ADDRESS;
  const token = new ethers.Contract(tokenAddr, VOTE_TOKEN_ABI, provider);

  await recoverPendingTasks(provider);
  await recoverPendingReverse(provider);

  let lastScannedBlock = (await provider.getBlockNumber()) - 1;

  async function pollLockedLogs(): Promise<void> {
    const head = await provider.getBlockNumber();
    if (head <= lastScannedBlock) return;
    const from = lastScannedBlock + 1;
    const to = head;
    const CHUNK = 2000;
    for (let start = from; start <= to; start += CHUNK) {
      const end = Math.min(start + CHUNK - 1, to);
      const filter = token.filters.Locked();
      const events = await token.queryFilter(filter, start, end);
      for (const ev of events) {
        if (!("args" in ev) || ev.args.length < 3) continue;
        await handleLockedLog(ev as ethers.EventLog, provider);
      }
    }
    lastScannedBlock = to;
  }

  setInterval(() => {
    void pollLockedLogs().catch((e) => logger.error(e, "[evm] poll Locked logs failed"));
  }, EVM_LOG_POLL_MS);
  void pollLockedLogs().catch((e) => logger.error(e, "[evm] initial poll failed"));

  logger.info(
    {
      token: tokenAddr,
      chainId: CONFIG.EVM_CHAIN_ID,
      storage: "memory",
      evmLogPollMs: EVM_LOG_POLL_MS
    },
    "poll Locked logs"
  );

  const app = express();
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      evmVoteToken: tokenAddr,
      stellarMint: CONFIG.STELLAR_WRAPPER_CONTRACT_ID,
      stellarOracleSigner: CONFIG.STELLAR_ORACLE_SOURCE || "env:STELLAR_ORACLE_SECRET",
      bridgeVoteCredit: CONFIG.BRIDGE_VOTE_CREDIT_ADDRESS || null,
      bridgeVoteCreditEnabled: isBridgeVoteCreditEnabled(),
      evmToStellarAmountDivisor: CONFIG.EVM_TO_STELLAR_AMOUNT_DIVISOR.toString(),
      reverseEvmMintEnabled: isReverseEvmMintEnabled(),
      directions: {
        evmToStellar:
          "Locked on ProbeBridgeToken → Soroban mint на STELLAR_WRAPPER_CONTRACT_ID (poll + replay-mint)",
        stellarToEvm:
          "POST /mint-from-stellar after Stellar lock tx SUCCESS → ProbeBridgeToken.mintFromStellar"
      }
    });
  });

  app.get("/status/:evmTxHash", (req, res) => {
    const task = store.findLatestByTxHash(req.params.evmTxHash);
    res.json(task ? taskToJson(task) : { error: "Not found" });
  });

  app.get("/status/stellar/:stellarTxHash", (req, res) => {
    try {
      const stellar0x = normalizeStellarTxHash0x(req.params.stellarTxHash);
      const task = reverseStore.findByStellarTxHash(stellar0x);
      res.json(task ? reverseTaskToJson(task) : { error: "Not found" });
    } catch (e) {
      res.status(400).json({ error: String((e as Error).message ?? e) });
    }
  });

  /**
   * Второе направление моста: после успешного lock на Stellar — минт ProbeBridgeToken на EVM.
   * stellarLockId в контракте = bytes32(нормализованный хеш Soroban tx).
   */
  app.post("/mint-from-stellar", async (req, res) => {
    try {
      if (!isReverseEvmMintEnabled()) {
        res.status(503).json({
          error:
            "Нужны ORACLE_EVM_PRIVATE_KEY и ProbeBridgeToken.setBridgeMinter(oracle); опционально REVERSE_EVM_MINT_ENABLED=false чтобы выключить"
        });
        return;
      }
      const { stellarTxHash, evmRecipient, amount: amountRaw } = req.body ?? {};
      if (!stellarTxHash || !evmRecipient || amountRaw == null) {
        res.status(400).json({ error: "need stellarTxHash, evmRecipient, amount" });
        return;
      }
      let stellar0x: string;
      try {
        stellar0x = normalizeStellarTxHash0x(stellarTxHash);
      } catch (e) {
        res.status(400).json({ error: String((e as Error).message) });
        return;
      }
      let recipient: string;
      try {
        recipient = ethers.getAddress(evmRecipient);
      } catch {
        res.status(400).json({ error: "invalid evmRecipient" });
        return;
      }
      let amount: bigint;
      try {
        amount = BigInt(amountRaw);
      } catch {
        res.status(400).json({ error: "invalid amount" });
        return;
      }
      if (amount <= 0n) {
        res.status(400).json({ error: "amount must be > 0" });
        return;
      }
      const amountStr = amount.toString();

      const existing = reverseStore.findByStellarTxHash(stellar0x);
      if (existing?.status === "PROCESSING") {
        res.status(409).json({
          error: "already processing",
          task: reverseTaskToJson(existing)
        });
        return;
      }
      if (existing?.status === "SUCCESS") {
        if (
          existing.evmRecipient.toLowerCase() !== recipient.toLowerCase() ||
          existing.amount !== amountStr
        ) {
          res.status(409).json({
            error: "stellar tx already minted with different recipient/amount",
            task: reverseTaskToJson(existing)
          });
          return;
        }
        res.json({ ok: true, task: reverseTaskToJson(existing) });
        return;
      }

      let taskId: number;
      if (!existing) {
        const t = reverseStore.create({
          stellarTxHash: stellar0x,
          evmRecipient: recipient,
          amount: amountStr,
          status: "PENDING",
          evmMintTxHash: null,
          error: null
        });
        taskId = t.id;
      } else {
        taskId = existing.id;
        reverseStore.update(taskId, {
          status: "PENDING",
          evmRecipient: recipient,
          amount: amountStr,
          error: null,
          evmMintTxHash: null
        });
      }

      await processReverseMintTask(taskId, provider);
      const done = reverseStore.findById(taskId);
      res.json({ ok: true, task: done ? reverseTaskToJson(done) : null });
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message ?? e) });
    }
  });

  app.post("/replay-mint", async (req, res) => {
    try {
      const { txHash, stellarDestination, amount } = req.body ?? {};
      if (!txHash || !stellarDestination || amount == null) {
        res.status(400).json({ error: "need txHash, stellarDestination, amount" });
        return;
      }
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) {
        res.status(404).json({ error: "receipt not found" });
        return;
      }
      const iface = new ethers.Interface(VOTE_TOKEN_ABI);
      const tokenLower = tokenAddr.toLowerCase();
      let logIndex = -1;
      let parsed: ethers.LogDescription | null = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== tokenLower) continue;
        try {
          const p = iface.parseLog(log);
          if (p?.name === "Locked") {
            parsed = p;
            logIndex = log.index;
            break;
          }
        } catch {
          /* skip */
        }
      }
      if (!parsed || logIndex < 0) {
        res.status(400).json({ error: "no Locked event from token in receipt" });
        return;
      }

      const existing = store.findByEvmKey(txHash, logIndex);

      if (existing) {
        await processTask(existing.id, provider);
        const updated = store.findById(existing.id);
        res.json({ ok: true, task: updated ? taskToJson(updated) : null });
        return;
      }

      const task = store.create({
        evmTxHash: txHash,
        logIndex,
        user: String(parsed.args[0]),
        amount: parsed.args[1].toString(),
        stellarDestination,
        status: "PENDING",
        stellarTxHash: null,
        error: null,
        evmCreditTxHash: null,
        evmCreditError: null
      });
      await processTask(task.id, provider);
      const done = store.findById(task.id);
      res.json({ ok: true, task: done ? taskToJson(done) : null });
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message ?? e) });
    }
  });

  app.post("/replay-evm-credit", async (req, res) => {
    try {
      const { txHash } = req.body ?? {};
      if (!txHash) {
        res.status(400).json({ error: "need txHash" });
        return;
      }
      const task = store.findLatestByTxHash(txHash);
      if (!task) {
        res.status(404).json({ error: "task not found" });
        return;
      }
      if (task.status !== "SUCCESS" || !task.stellarTxHash) {
        res.status(400).json({ error: "need SUCCESS task with stellarTxHash" });
        return;
      }
      const creditAmt = stellarMintAmountFromEvmLock(BigInt(task.amount)).toString();
      const creditResult = await recordBridgedVoteCredit(provider, task, creditAmt);
      store.update(task.id, {
        evmCreditTxHash: creditResult.txHash ?? task.evmCreditTxHash,
        evmCreditError: creditResult.error
      });
      const updated = store.findById(task.id);
      res.json({ ok: true, task: updated ? taskToJson(updated) : null });
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message ?? e) });
    }
  });

  const port = CONFIG.PORT;
  app.listen(port, "0.0.0.0", () => {
    logger.info(`HTTP 0.0.0.0:${port}`);
  });
}

main().catch((e) => {
  logger.fatal(e);
  process.exit(1);
});
