export type PerplAmount = string;
export type PerplUint64 = number;

export interface PerplAuthHeaders {
  "X-API-Key": string;
  "X-API-Timestamp": string;
  "X-API-Nonce": string;
  "X-API-Signature": string;
}

export interface PerplApiKeySignIn {
  mt: 29;
  chain_id: number;
  api_key: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

export interface PerplTimestamp { b?: number; t?: number; tx?: number; txid?: string; l?: number }
export interface PerplAccountEvent { at: PerplTimestamp; in: number; id: number; et: number; m?: number; r?: number; o?: number; p?: number; a: PerplAmount; b: PerplAmount; lb: PerplAmount; f: PerplAmount; bfa?: PerplAmount }
export interface PerplAccount { in: number; id: number; fr: boolean; fw: boolean; ft: number; lfr: PerplUint64; b: PerplAmount; lb: PerplAmount; h?: PerplAccountEvent[] }
export interface PerplAccountStats { in: number; id: number; td: PerplAmount; tw: PerplAmount; tv: PerplAmount; tf: PerplAmount; tbf?: PerplAmount; trp: PerplAmount; wr: number; tt: number }
export interface PerplOrder { at: PerplTimestamp; c: PerplTimestamp; rq: PerplUint64; mkt: number; acc: PerplUint64; oid: PerplUint64; scid: PerplUint64; st: number; sr: number; t: number; r?: boolean; p?: PerplUint64; os: PerplUint64; fp: PerplUint64; fs: PerplUint64; f: PerplAmount; bfa?: PerplAmount; tif?: number; fl: number; tp?: PerplUint64; tpc?: number; lp?: PerplUint64; mm: number; lv: number }
export interface PerplFill { at: PerplTimestamp; mkt: number; acc: PerplUint64; oid: PerplUint64; t: number; l: number; p?: PerplUint64; s: PerplUint64; f: PerplAmount; bfa?: PerplAmount }
export interface PerplPosition { at: PerplTimestamp; mkt: number; acc: PerplUint64; pid: PerplUint64; rq: PerplUint64; oid: PerplUint64; st: number; sr: number; sd: number; c: PerplAmount; ep: PerplUint64; epr?: number; s: PerplUint64; fee: PerplAmount; efs: number; lv: number; dpnl?: PerplAmount; fnd?: PerplAmount; xp?: PerplUint64; xfs: number; ots: PerplTimestamp; e?: PerplPosition[] }

export interface PerplWalletSnapshot { mt: 19; sn: PerplUint64; at: PerplTimestamp; addr: string; n: PerplUint64; fl: number; as?: PerplAccount[]; sts?: PerplAccountStats[] }
export interface PerplWalletUpdate { mt: 20; at: PerplTimestamp; addr: string; n: PerplUint64; fl: number }
export interface PerplAccountUpdate extends PerplAccount { mt: 21 }
export interface PerplOrderRequest { mt: 22; sn?: PerplUint64; rq: PerplUint64; mkt: number; acc: PerplUint64; oid?: PerplUint64; t: number; p?: PerplUint64; s: PerplUint64; a?: PerplAmount; ms?: number; tif?: number; fl: number; tp?: PerplUint64; tpc?: number; tr?: PerplUint64; lp?: PerplUint64; lv: number; lb: PerplUint64; bf?: number }
export interface PerplOrdersSnapshot { mt: 23; at: PerplTimestamp; d: PerplOrder[] }
export interface PerplOrdersUpdate { mt: 24; at: PerplTimestamp; d: PerplOrder[] }
export interface PerplFillsUpdate { mt: 25; at: PerplTimestamp; d: PerplFill[] }
export interface PerplPositionsSnapshot { mt: 26; at: PerplTimestamp; d: PerplPosition[] }
export interface PerplPositionsUpdate { mt: 27; at: PerplTimestamp; d: PerplPosition[] }
export interface PerplAccountStatsUpdate extends PerplAccountStats { mt: 28 }
export type PerplAuthenticatedFrame = PerplWalletSnapshot | PerplWalletUpdate | PerplAccountUpdate | PerplOrderRequest | PerplOrdersSnapshot | PerplOrdersUpdate | PerplFillsUpdate | PerplPositionsSnapshot | PerplPositionsUpdate | PerplAccountStatsUpdate | PerplApiKeySignIn;
