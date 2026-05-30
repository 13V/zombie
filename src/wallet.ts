/**
 * Lightweight Solana wallet connector — NO npm dependencies. Talks to the
 * wallet's injected provider (Phantom / Solflare / Backpack) via `window.solana`.
 *
 * SECURITY MODEL (read before extending):
 *  - The client NEVER holds private keys and NEVER moves funds. Connecting only
 *    reveals the user's public address + lets them SIGN a login message.
 *  - "Claiming" earned rewards must be authorized by a TRUSTED BACKEND that
 *    independently verifies the run (see requestClaim — it only *asks*; it does
 *    not pay). A static client cannot safely pay anyone (it's inspectable JS).
 *  - Token "balance" shown here is read-only display from a public RPC.
 */

export interface WalletState {
  connected: boolean;
  address: string | null;
  /** Display balance of the game token (or null until fetched). */
  tokenBalance: number | null;
}

type Provider = {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toString(): string } }>;
  disconnect: () => Promise<void>;
  signMessage?: (msg: Uint8Array, enc?: string) => Promise<{ signature: Uint8Array }>;
  on?: (event: string, cb: (...a: any[]) => void) => void;
};

function getProvider(): Provider | null {
  const w = window as any;
  if (w.phantom?.solana?.isPhantom) return w.phantom.solana as Provider;
  if (w.solana) return w.solana as Provider;
  return null;
}

export class Wallet {
  state: WalletState = { connected: false, address: null, tokenBalance: null };
  onChange?: (s: WalletState) => void;

  get available(): boolean {
    return getProvider() !== null;
  }

  /** Short display form: "AbCd…WxYz". */
  get short(): string {
    const a = this.state.address;
    return a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "";
  }

  /** Try to reconnect silently if the user trusted us before. */
  async tryEagerConnect() {
    const p = getProvider();
    if (!p) return;
    try {
      const res = await p.connect({ onlyIfTrusted: true });
      this.applyConnected(res.publicKey.toString());
      p.on?.("disconnect", () => this.applyDisconnected());
      p.on?.("accountChanged", (pk: any) => {
        if (pk) this.applyConnected(pk.toString());
        else this.applyDisconnected();
      });
    } catch {
      /* not previously trusted — stay disconnected */
    }
  }

  /** Explicit connect (opens the wallet popup). Returns the address or null. */
  async connect(): Promise<string | null> {
    const p = getProvider();
    if (!p) {
      window.open("https://phantom.app/", "_blank", "noopener");
      return null;
    }
    try {
      const res = await p.connect();
      const addr = res.publicKey.toString();
      this.applyConnected(addr);
      p.on?.("disconnect", () => this.applyDisconnected());
      return addr;
    } catch {
      return null; // user rejected
    }
  }

  async disconnect() {
    try {
      await getProvider()?.disconnect();
    } catch {
      /* ignore */
    }
    this.applyDisconnected();
  }

  private applyConnected(address: string) {
    this.state = { connected: true, address, tokenBalance: this.state.tokenBalance };
    this.onChange?.(this.state);
  }
  private applyDisconnected() {
    this.state = { connected: false, address: null, tokenBalance: null };
    this.onChange?.(this.state);
  }

  /**
   * Request a payout of earned rewards. This is intentionally a STUB: a static
   * client must never move funds. When a backend exists, POST the run's verified
   * proof here and let the server's treasury sign + send the transfer.
   * Returns a human-readable status for the UI.
   */
  async requestClaim(_amount: number): Promise<{ ok: boolean; message: string }> {
    if (!this.state.connected) return { ok: false, message: "Connect a wallet first" };
    // No backend wired yet — be honest in the UI rather than fake a payout.
    return {
      ok: false,
      message: "Claiming goes live once the reward backend + token launch — your balance is saved.",
    };
  }
}
