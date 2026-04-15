import "dotenv/config";
import { execFileSync } from "node:child_process";
import { ethers } from "ethers";

export const CONFIG = {
  EVM_RPC_URL: process.env.EVM_RPC_URL ?? "https://YOUR_RPC_ENDPOINT",
  EVM_CHAIN_ID: Number(process.env.EVM_CHAIN_ID ?? "420420417"),
  VOTE_TOKEN_ADDRESS: process.env.VOTE_TOKEN_ADDRESS ?? "0xB3261862181dA73c029D8072c947A9CC8631a59f",
  CONFIRMATIONS: Number(process.env.CONFIRMATIONS ?? "1"),

  STELLAR_RPC_URL:
    process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
  STELLAR_NETWORK_PASSPHRASE:
    process.env.STELLAR_NETWORK_PASSPHRASE ??
    "Test SDF Network ; September 2015",
  STELLAR_ORACLE_SECRET:
    process.env.STELLAR_ORACLE_SECRET ?? "SDEMO_REPLACE_WITH_REAL_SECRET",
  /** Имя локальной identity в Stellar CLI (как у `stellar contract invoke --source NAME`). */
  STELLAR_ORACLE_SOURCE: (process.env.STELLAR_ORACLE_SOURCE ?? "").trim(),
  STELLAR_WRAPPER_CONTRACT_ID:
    process.env.STELLAR_WRAPPER_CONTRACT_ID ??
    "CC76GB4WIXVIXGCC7X7R2SERJQIXWJJSAZMBGU7PAPGGCSGSEC6POQ5P",
  STELLAR_WVOTE_CONTRACT_ID:
    process.env.STELLAR_WVOTE_CONTRACT_ID ??
    "CDMPMBGFKGAFXJ3QKRHAGADIGPUHHEONTJJ6MDAT5F4LLHYQWXVSDIXK",

  /**
   * EVM → Stellar: сумма из события Locked (минимальные единицы EVM) делится на этот делитель
   * перед вызовом Soroban mint (и тем же значением — recordBridgedLock, если включён кредит).
   * По умолчанию 1e5: 1e-10 ETH (100_000_000 wei) → 1000 единиц Soroban mint. Без масштаба: 1
   */
  EVM_TO_STELLAR_AMOUNT_DIVISOR: (() => {
    const raw = (process.env.EVM_TO_STELLAR_AMOUNT_DIVISOR ?? "").trim();
    if (raw === "") return 100_000n;
    try {
      const x = BigInt(raw);
      return x > 0n ? x : 100_000n;
    } catch {
      return 100_000n;
    }
  })(),

  /** EVM: после mint на Stellar оракул зачисляет кредит голоса (опционально). */
  BRIDGE_VOTE_CREDIT_ADDRESS: (process.env.BRIDGE_VOTE_CREDIT_ADDRESS ?? "").trim(),
  ORACLE_EVM_PRIVATE_KEY: (process.env.ORACLE_EVM_PRIVATE_KEY ?? "").trim(),

  /**
   * Stellar → EVM: POST /mint-from-stellar (нужен ORACLE_EVM_PRIVATE_KEY и ProbeBridgeToken.setBridgeMinter).
   * По умолчанию включено, если задан валидный ORACLE_EVM_PRIVATE_KEY; выключить: REVERSE_EVM_MINT_ENABLED=false
   */
  REVERSE_EVM_MINT_ENABLED: (() => {
    const v = (process.env.REVERSE_EVM_MINT_ENABLED ?? "").trim().toLowerCase();
    if (v === "0" || v === "false" || v === "off" || v === "no") return false;
    return true;
  })(),

  PORT: Number(process.env.PORT ?? process.env.ORACLE_HTTP_PORT ?? "8080")
};

const SECRET_RE = /\b(S[A-Z2-7]{55})\b/;

/** Секрет для подписи mint: из CLI-identity, если задан STELLAR_ORACLE_SOURCE, иначе STELLAR_ORACLE_SECRET. */
export function resolveStellarOracleSecret(): string {
  const alias = CONFIG.STELLAR_ORACLE_SOURCE;
  if (!alias) {
    return CONFIG.STELLAR_ORACLE_SECRET;
  }
  const tryBins: [string, string[]][] = [
    ["stellar", ["keys", "show", alias]],
    ["soroban", ["keys", "show", alias]]
  ];
  for (const [bin, args] of tryBins) {
    try {
      const out = execFileSync(bin, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }).trim();
      const m = out.match(SECRET_RE);
      if (m) return m[1];
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `STELLAR_ORACLE_SOURCE=${alias}: не удалось прочитать секрет через stellar/soroban keys show (CLI в PATH?)`
  );
}

export function isBridgeVoteCreditEnabled(): boolean {
  if (!CONFIG.BRIDGE_VOTE_CREDIT_ADDRESS) return false;
  if (!CONFIG.ORACLE_EVM_PRIVATE_KEY) return false;
  if (CONFIG.ORACLE_EVM_PRIVATE_KEY.includes("REPLACE")) return false;
  try {
    ethers.getAddress(CONFIG.BRIDGE_VOTE_CREDIT_ADDRESS);
    return true;
  } catch {
    return false;
  }
}

/** Обратный минт на EVM: только если явно не выключено и есть ключ оракула. */
export function isReverseEvmMintEnabled(): boolean {
  if (!CONFIG.REVERSE_EVM_MINT_ENABLED) return false;
  if (!CONFIG.ORACLE_EVM_PRIVATE_KEY) return false;
  if (CONFIG.ORACLE_EVM_PRIVATE_KEY.includes("REPLACE")) return false;
  return true;
}

/** Сумма lock на EVM → величина для Soroban mint (целочисленное деление). */
export function stellarMintAmountFromEvmLock(evmLockedMinimal: bigint): bigint {
  const d = CONFIG.EVM_TO_STELLAR_AMOUNT_DIVISOR;
  if (d === 1n) return evmLockedMinimal;
  return evmLockedMinimal / d;
}

export function assertConfig(): void {
  if (!CONFIG.EVM_RPC_URL || CONFIG.EVM_RPC_URL.includes("YOUR_RPC")) {
    throw new Error("Задайте EVM_RPC_URL в .env или переменных окружения");
  }
  try {
    if (ethers.getAddress(CONFIG.VOTE_TOKEN_ADDRESS) === ethers.ZeroAddress) {
      throw new Error("zero");
    }
  } catch {
    throw new Error("Задайте VOTE_TOKEN_ADDRESS (не нулевой адрес ProbeBridgeToken)");
  }
  const secretOk =
    CONFIG.STELLAR_ORACLE_SECRET &&
    !CONFIG.STELLAR_ORACLE_SECRET.includes("REPLACE");
  if (!CONFIG.STELLAR_ORACLE_SOURCE && !secretOk) {
    throw new Error(
      "Задайте STELLAR_ORACLE_SECRET (S...) или STELLAR_ORACLE_SOURCE (имя identity из stellar CLI)"
    );
  }
}
