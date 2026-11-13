/**
 * Chain registry and address-type detection. Shared by server and client (no secrets here).
 * Public RPC URLs are keyless defaults; each can be overridden server-side with EVM_RPC_URL_<KEY>.
 */
import { isValidMint } from "../validate";

export type ChainFamily = "solana" | "evm";
export type EvmChainKey = "ethereum" | "bsc" | "base" | "arbitrum" | "polygon" | "optimism" | "avalanche";
export type ChainKey = "solana" | EvmChainKey;

export interface ChainInfo {
  key: ChainKey;
  name: string;
  family: ChainFamily;
  /** DexScreener chainId. */
  dexId: string;
  /** GoPlus chain id (EVM numeric id as a string), or "solana". */
  goplusId: string;
  /** Default keyless public RPCs, tried in order. */
  rpcs: string[];
  explorerName: string;
  explorerToken: (address: string) => string;
}

export const CHAINS: Record<ChainKey, ChainInfo> = {
  solana: { key: "solana", name: "Solana", family: "solana", dexId: "solana", goplusId: "solana", rpcs: [], explorerName: "Solscan", explorerToken: (a) => `https://solscan.io/token/${a}` },
  ethereum: { key: "ethereum", name: "Ethereum", family: "evm", dexId: "ethereum", goplusId: "1", rpcs: ["https://ethereum-rpc.publicnode.com", "https://cloudflare-eth.com"], explorerName: "Etherscan", explorerToken: (a) => `https://etherscan.io/token/${a}` },
  bsc: { key: "bsc", name: "BNB Chain", family: "evm", dexId: "bsc", goplusId: "56", rpcs: ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org"], explorerName: "BscScan", explorerToken: (a) => `https://bscscan.com/token/${a}` },
  base: { key: "base", name: "Base", family: "evm", dexId: "base", goplusId: "8453", rpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"], explorerName: "BaseScan", explorerToken: (a) => `https://basescan.org/token/${a}` },
  arbitrum: { key: "arbitrum", name: "Arbitrum", family: "evm", dexId: "arbitrum", goplusId: "42161", rpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"], explorerName: "Arbiscan", explorerToken: (a) => `https://arbiscan.io/token/${a}` },
  polygon: { key: "polygon", name: "Polygon", family: "evm", dexId: "polygon", goplusId: "137", rpcs: ["https://polygon-bor-rpc.publicnode.com"], explorerName: "PolygonScan", explorerToken: (a) => `https://polygonscan.com/token/${a}` },
  optimism: { key: "optimism", name: "Optimism", family: "evm", dexId: "optimism", goplusId: "10", rpcs: ["https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io"], explorerName: "Optimistic Etherscan", explorerToken: (a) => `https://optimistic.etherscan.io/token/${a}` },
  avalanche: { key: "avalanche", name: "Avalanche", family: "evm", dexId: "avalanche", goplusId: "43114", rpcs: ["https://avalanche-c-chain-rpc.publicnode.com", "https://api.avax.network/ext/bc/C/rpc"], explorerName: "Snowtrace", explorerToken: (a) => `https://snowtrace.io/token/${a}` },
};

/** Probe order when nothing else tells us the chain. */
export const EVM_CHAINS: EvmChainKey[] = ["ethereum", "bsc", "base", "arbitrum", "polygon", "optimism", "avalanche"];

export function isChainKey(v: unknown): v is ChainKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(CHAINS, v);
}

export function chainByDexId(dexId: unknown): ChainKey | undefined {
  return (Object.keys(CHAINS) as ChainKey[]).find((k) => CHAINS[k].dexId === dexId);
}

export function isEvmAddress(input: unknown): input is string {
  return typeof input === "string" && /^0x[0-9a-fA-F]{40}$/.test(input.trim());
}

export type AddressKind = { kind: "solana"; address: string } | { kind: "evm"; address: string } | { kind: "invalid" };

/** 0x + 40 hex is EVM; base58 that decodes to 32 bytes is a Solana address; anything else is invalid. */
export function detectAddress(input: unknown): AddressKind {
  if (typeof input !== "string") return { kind: "invalid" };
  const s = input.trim();
  if (isEvmAddress(s)) return { kind: "evm", address: s };
  if (isValidMint(s)) return { kind: "solana", address: s };
  return { kind: "invalid" };
}
