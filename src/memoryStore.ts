export type TaskStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED";

export interface BridgeTaskRecord {
  id: number;
  evmTxHash: string;
  logIndex: number;
  user: string;
  amount: string;
  stellarDestination: string;
  status: TaskStatus;
  stellarTxHash: string | null;
  error: string | null;
  evmCreditTxHash: string | null;
  evmCreditError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function key(evmTxHash: string, logIndex: number): string {
  return `${evmTxHash.toLowerCase()}:${logIndex}`;
}

export class MemoryStore {
  private nextId = 1;
  private readonly byId = new Map<number, BridgeTaskRecord>();
  private readonly byKey = new Map<string, number>();

  findById(id: number): BridgeTaskRecord | undefined {
    return this.byId.get(id);
  }

  findByEvmKey(evmTxHash: string, logIndex: number): BridgeTaskRecord | undefined {
    const id = this.byKey.get(key(evmTxHash, logIndex));
    return id !== undefined ? this.byId.get(id) : undefined;
  }

  findLatestByTxHash(evmTxHash: string): BridgeTaskRecord | undefined {
    const want = evmTxHash.toLowerCase();
    let best: BridgeTaskRecord | undefined;
    for (const t of this.byId.values()) {
      if (t.evmTxHash.toLowerCase() === want) {
        if (!best || t.id > best.id) best = t;
      }
    }
    return best;
  }

  create(data: Omit<BridgeTaskRecord, "id" | "createdAt" | "updatedAt">): BridgeTaskRecord {
    const id = this.nextId++;
    const now = new Date();
    const row: BridgeTaskRecord = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now
    };
    this.byId.set(id, row);
    this.byKey.set(key(data.evmTxHash, data.logIndex), id);
    return row;
  }

  update(
    id: number,
    patch: Partial<
      Pick<
        BridgeTaskRecord,
        | "status"
        | "stellarTxHash"
        | "error"
        | "stellarDestination"
        | "amount"
        | "user"
        | "evmCreditTxHash"
        | "evmCreditError"
      >
    >
  ): BridgeTaskRecord | undefined {
    const row = this.byId.get(id);
    if (!row) return undefined;
    const next: BridgeTaskRecord = {
      ...row,
      ...patch,
      updatedAt: new Date()
    };
    this.byId.set(id, next);
    return next;
  }

  listStuck(): BridgeTaskRecord[] {
    const s: TaskStatus[] = ["PENDING", "FAILED", "PROCESSING"];
    return [...this.byId.values()].filter((t) => s.includes(t.status));
  }
}

/** Stellar lock → минт ProbeBridgeToken на EVM (второе направление моста). */
export interface ReverseMintRecord {
  id: number;
  /** Нормализованный хеш Soroban tx: `0x` + 64 hex */
  stellarTxHash: string;
  evmRecipient: string;
  amount: string;
  status: TaskStatus;
  evmMintTxHash: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function stellarKey(h: string): string {
  return h.trim().toLowerCase();
}

export class ReverseMintStore {
  private nextId = 1;
  private readonly byId = new Map<number, ReverseMintRecord>();
  private readonly byStellar = new Map<string, number>();

  findById(id: number): ReverseMintRecord | undefined {
    return this.byId.get(id);
  }

  findByStellarTxHash(stellarTxHash: string): ReverseMintRecord | undefined {
    const id = this.byStellar.get(stellarKey(stellarTxHash));
    return id !== undefined ? this.byId.get(id) : undefined;
  }

  create(
    data: Omit<ReverseMintRecord, "id" | "createdAt" | "updatedAt">
  ): ReverseMintRecord {
    const id = this.nextId++;
    const now = new Date();
    const row: ReverseMintRecord = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now
    };
    this.byId.set(id, row);
    this.byStellar.set(stellarKey(data.stellarTxHash), id);
    return row;
  }

  update(
    id: number,
    patch: Partial<
      Pick<
        ReverseMintRecord,
        "status" | "evmMintTxHash" | "error" | "evmRecipient" | "amount"
      >
    >
  ): ReverseMintRecord | undefined {
    const row = this.byId.get(id);
    if (!row) return undefined;
    const next: ReverseMintRecord = {
      ...row,
      ...patch,
      updatedAt: new Date()
    };
    this.byId.set(id, next);
    return next;
  }

  listStuck(): ReverseMintRecord[] {
    const s: TaskStatus[] = ["PENDING", "FAILED", "PROCESSING"];
    return [...this.byId.values()].filter((t) => s.includes(t.status));
  }
}
