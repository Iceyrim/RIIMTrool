import {
  AbiCoder,
  Signature,
  Wallet,
  keccak256,
  toUtf8Bytes,
  type TypedDataDomain,
} from "ethers";
import type { RiseXPermitRaw } from "./authTypes.js";

export interface RiseXNonceState {
  nonceAnchor: bigint;
  nonceBitmapIndex: number;
}

export interface RiseXPermitContext {
  domain: {
    name: string;
    version: string;
    chainId: string | number;
    verifyingContract: string;
  };
  account: string;
  router: string;
  nonce: RiseXNonceState;
  deadline: number;
}

export interface RiseXPlaceAction {
  marketId: number;
  sizeSteps: number;
  priceTicks: number;
  side: number;
  postOnly: boolean;
  reduceOnly: boolean;
  stpMode: number;
  orderType: number;
  timeInForce: number;
  builderId: number;
  clientOrderId: bigint;
  ttlUnits: number;
  builderFeeBps: number;
}

export interface RiseXCancelAction {
  marketId: number;
  restingOrderId: bigint;
}

export interface RiseXPermitSigner {
  readonly address: string;
  signPlace(context: RiseXPermitContext, action: RiseXPlaceAction): Promise<RiseXPermitRaw>;
  signCancel(context: RiseXPermitContext, action: RiseXCancelAction): Promise<RiseXPermitRaw>;
}

const coder = AbiCoder.defaultAbiCoder();
const PLACE_SELECTOR = keccak256(toUtf8Bytes("RISE_PERPS_PLACE_ORDER_V1"));
const CANCEL_SELECTOR = keccak256(toUtf8Bytes("RISE_PERPS_CANCEL_ORDER_V1"));

function checked(value: number | bigint, maximum: bigint, name: string): bigint {
  const resolved = BigInt(value);
  if (resolved < 0n || resolved > maximum) throw new Error(`${name} is outside its protocol range`);
  return resolved;
}

export function packRiseXOrderData(action: RiseXPlaceAction): bigint {
  const marketId = checked(action.marketId, 0xffffn, "marketId");
  const sizeSteps = checked(action.sizeSteps, 0xffff_ffffn, "sizeSteps");
  const priceTicks = checked(action.priceTicks, 0xff_ffffn, "priceTicks");
  const side = checked(action.side, 1n, "side");
  const stpMode = checked(action.stpMode, 3n, "stpMode");
  const orderType = checked(action.orderType, 1n, "orderType");
  const timeInForce = checked(action.timeInForce, 3n, "timeInForce");
  const flags = side |
    (action.postOnly ? 1n << 1n : 0n) |
    (action.reduceOnly ? 1n << 2n : 0n) |
    (stpMode << 3n) |
    (orderType << 5n) |
    (timeInForce << 6n);
  return (marketId << 70n) | (sizeSteps << 38n) | (priceTicks << 14n) | (flags << 6n) | (1n << 1n);
}

export function hashRiseXPlaceAction(action: RiseXPlaceAction): string {
  checked(action.builderId, 0xffffn, "builderId");
  checked(action.clientOrderId, 0xffff_ffff_ffff_ffffn, "clientOrderId");
  checked(action.ttlUnits, 0xffffn, "ttlUnits");
  checked(action.builderFeeBps, 0xffffn, "builderFeeBps");
  const headerFlags = 1 |
    (action.builderId !== 0 ? 2 : 0) |
    (action.clientOrderId !== 0n ? 4 : 0) |
    (action.ttlUnits !== 0 ? 16 : 0);
  const values: unknown[] = [PLACE_SELECTOR, headerFlags, packRiseXOrderData(action), action.builderId];
  const types = ["bytes32", "uint8", "uint88", "uint16"];
  if (action.builderFeeBps !== 0) {
    types.push("uint16");
    values.push(action.builderFeeBps);
  }
  types.push("uint64", "uint16");
  values.push(action.clientOrderId, action.ttlUnits);
  return keccak256(coder.encode(types, values));
}

export function hashRiseXCancelAction(action: RiseXCancelAction): string {
  checked(action.marketId, 0xffffn, "marketId");
  checked(action.restingOrderId, (1n << 256n) - 1n, "restingOrderId");
  return keccak256(
    coder.encode(["bytes32", "uint256", "uint256"], [CANCEL_SELECTOR, action.marketId, action.restingOrderId]),
  );
}

const VERIFY_WITNESS = {
  VerifyWitness: [
    { name: "account", type: "address" },
    { name: "target", type: "address" },
    { name: "hash", type: "bytes32" },
    { name: "nonceAnchor", type: "uint48" },
    { name: "nonceBitmap", type: "uint8" },
    { name: "deadline", type: "uint32" },
  ],
};

export class EthersRiseXPermitSigner implements RiseXPermitSigner {
  private readonly wallet: Wallet;
  readonly address: string;

  constructor(privateKey: string) {
    this.wallet = new Wallet(privateKey);
    this.address = this.wallet.address;
  }

  async signPlace(context: RiseXPermitContext, action: RiseXPlaceAction): Promise<RiseXPermitRaw> {
    return this.sign(context, hashRiseXPlaceAction(action));
  }

  async signCancel(context: RiseXPermitContext, action: RiseXCancelAction): Promise<RiseXPermitRaw> {
    return this.sign(context, hashRiseXCancelAction(action));
  }

  private async sign(context: RiseXPermitContext, hash: string): Promise<RiseXPermitRaw> {
    if (context.nonce.nonceBitmapIndex < 0 || context.nonce.nonceBitmapIndex > 207)
      throw new Error("RISEx nonce bitmap index must be 0..207");
    const domain: TypedDataDomain = {
      name: context.domain.name,
      version: context.domain.version,
      chainId: BigInt(context.domain.chainId),
      verifyingContract: context.domain.verifyingContract,
    };
    const signature = await this.wallet.signTypedData(domain, VERIFY_WITNESS, {
      account: context.account,
      target: context.router,
      hash,
      nonceAnchor: context.nonce.nonceAnchor,
      nonceBitmap: context.nonce.nonceBitmapIndex,
      deadline: context.deadline,
    });
    const compact = Signature.from(signature).compactSerialized;
    return {
      account: context.account,
      signer: this.address,
      nonce_anchor: context.nonce.nonceAnchor.toString(10),
      nonce_bitmap_index: context.nonce.nonceBitmapIndex,
      deadline: context.deadline,
      signature: Buffer.from(compact.slice(2), "hex").toString("base64"),
    };
  }
}

