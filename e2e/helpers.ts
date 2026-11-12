import { expect, type CDPSession, type Page } from '@playwright/test';
import { HDNodeWallet, Mnemonic } from 'ethers';
import { DERIVED_KEY_LABELS, deriveKeyMaterial } from '../packages/vault/src/index.ts';

/**
 * Chrome's virtual authenticator: a software passkey device we fully control.
 * https://chromedevtools.github.io/devtools-protocol/tot/WebAuthn/
 */
export interface DeviceOptions {
  /** Supports the PRF extension (needed to open the wallet). */
  prf?: boolean;
  /** Synced passkey (iCloud/Google) vs device-only (security key, some Windows Hello). */
  synced?: boolean;
  /** Face ID / fingerprint / PIN succeeds. */
  userVerified?: boolean;
  /** 'internal' = built into this computer (Chrome allows only one); 'usb' = phone/security key stand-in. */
  transport?: 'internal' | 'usb';
}

export class Device {
  private constructor(
    readonly cdp: CDPSession,
    readonly id: string,
  ) {}

  static async add(page: Page, o: DeviceOptions = {}): Promise<Device> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: o.transport ?? 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: o.userVerified ?? true,
        automaticPresenceSimulation: true,
        hasPrf: o.prf ?? true,
        defaultBackupEligibility: o.synced ?? true,
        defaultBackupState: o.synced ?? true,
      },
    });
    return new Device(cdp, authenticatorId);
  }

  async credentials() {
    return (await this.cdp.send('WebAuthn.getCredentials', { authenticatorId: this.id })).credentials;
  }

  /** The passkey disappears from the device (deleted, or device lost). */
  async forgetAll() {
    await this.cdp.send('WebAuthn.clearCredentials', { authenticatorId: this.id });
  }

  async setUserVerified(ok: boolean) {
    await this.cdp.send('WebAuthn.setUserVerified', { authenticatorId: this.id, isUserVerified: ok });
  }

  /**
   * Whether this device answers prompts by itself. With several simulated
   * devices, turn it off on the ones the user wouldn't touch: real devices
   * only respond when you use them.
   */
  async setResponds(on: boolean) {
    await this.cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: this.id, enabled: on });
  }

  /** Unplug the device. Its passkeys go with it. */
  async remove() {
    await this.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: this.id });
  }
}

let counter = 0;
export const freshEmail = () => `tester${Date.now()}-${counter++}@example.com`;

export async function latestCode(page: Page, email: string): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(async () => {
      const { emails } = (await (await page.request.get('/api/dev/outbox')).json()) as {
        emails: { to: string; subject: string }[];
      };
      code = emails.find((e) => e.to === email)?.subject.match(/\d{6}/)?.[0];
      return code;
    })
    .toBeTruthy();
  return code!;
}

export async function verifyEmail(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('6-digit code').fill(await latestCode(page, email));
}

export async function signUp(page: Page, email = freshEmail()) {
  await verifyEmail(page, email);
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  return email;
}

/** The signed-in pages (sidebar on desktop). The hash keeps the page across reloads and sign-in. */
export async function goTo(page: Page, name: 'Home' | 'Notifications' | 'Verification' | 'Settings') {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
}

/** Home's Send / Receive pop-ups. */
export async function openSheet(page: Page, name: 'Send' | 'Receive') {
  await goTo(page, 'Home');
  await page.getByRole('button', { name, exact: true }).click();
  return page.getByRole('dialog', { name });
}
/**
 * The Send pop-up's options: a private send, or out to an Ethereum or Solana address (a withdrawal).
 * Steps back to the options first if the pop-up is already on another screen.
 */
export async function chooseSend(page: Page, where: 'Privately via Railgun' | 'To an Ethereum address' | 'To a Solana address') {
  const dlg = page.getByRole('dialog', { name: 'Send' });
  if (!(await dlg.isVisible())) await openSheet(page, 'Send');
  const row = dlg.getByRole('button', { name: where });
  while (!(await row.isVisible())) await dlg.getByRole('button', { name: 'Previous step' }).click();
  await row.click();
  // Each form stays mounted (hidden) while you step around: return the one just opened.
  const mode = { 'Privately via Railgun': 'private', 'To an Ethereum address': 'evm', 'To a Solana address': 'sol' }[where];
  return dlg.locator(`[data-send-mode="${mode}"]`);
}

/** Errors are toasts now (Gold, 12 Nov): the latest one. */
export const errorToast = (page: Page) => page.locator('[data-sonner-toast][data-type="error"]').last();

/** What the Home balance says is spendable now, in USDT (it stays readable behind a pop-up). */
export async function spendableUsdt(page: Page): Promise<number> {
  const t = (await page.getByTestId('balance-Spendable-usdt').textContent({ timeout: 1_000 }).catch(() => '')) ?? '';
  return Number(/\$?([\d,.]+)/.exec(t)?.[1]?.replace(/,/g, '') ?? 0);
}

/** Esc closes any pop-up (the redesigned ones, like Receive, have no × button). */
export async function closeSheet(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

export async function walletCheck(page: Page): Promise<string> {
  await goTo(page, 'Settings');
  const text = await page.getByText('Wallet check:').locator('code').textContent();
  return text!.trim();
}

export async function signOut(page: Page) {
  await goTo(page, 'Settings');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
}

/**
 * Records every secret the page handles, so tests can prove none of them ever
 * leaves the device: PRF outputs (from getClientExtensionResults), the
 * plaintext the vault encrypts (the root secret), the root secret transferred to
 * the Railgun worker, and what the worker derives from it (recomputed here):
 * the recovery phrase, the Railgun DB key, the deposit-records key and the
 * private keys of the first deposit addresses. Checks every request, including
 * the worker's, plus browser storage. Test-only instrumentation; the app
 * itself exposes nothing.
 */
export async function recordSecrets(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = ((window as unknown as { __secrets: string[] }).__secrets = []);
    const hex = (b: ArrayBuffer | ArrayBufferView) =>
      Array.from(
        b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
        (x) => x.toString(16).padStart(2, '0'),
      ).join('');
    const orig = PublicKeyCredential.prototype.getClientExtensionResults;
    PublicKeyCredential.prototype.getClientExtensionResults = function () {
      const r = orig.call(this);
      const first = r.prf?.results?.first;
      if (first) seen.push(hex(first));
      return r;
    };
    const enc = crypto.subtle.encrypt.bind(crypto.subtle);
    crypto.subtle.encrypt = (alg, key, data) => {
      seen.push(hex(data as ArrayBuffer));
      return enc(alg, key, data);
    };
    // The root secret as transferred to the Railgun worker (captured before the transfer empties it).
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, msg: unknown, ...rest: unknown[]) {
      const m = msg as { type?: string; rootSecret?: ArrayBuffer };
      if (m?.type === 'open' && m.rootSecret) seen.push(hex(m.rootSecret));
      return (post as (...a: unknown[]) => void).call(this, msg, ...rest);
    } as typeof Worker.prototype.postMessage;
  });
  const sent: string[] = [];
  const hosts = new Set<string>();
  // Context-level, so requests made by Web Workers (the Railgun wallet) are included.
  page.context().on('request', (r) => {
    hosts.add(new URL(r.url()).hostname);
    sent.push(r.url() + '\n' + (r.postData() ?? '') + '\n' + JSON.stringify(r.headers()));
  });
  return {
    /** Hostnames seen so far, to prove the recorder actually captured the traffic it checks. */
    hosts: () => [...hosts],
    async assertNoLeaks() {
      const secrets = [...new Set(await page.evaluate(() => (window as unknown as { __secrets: string[] }).__secrets))];
      expect(secrets.length, 'test should have observed some secrets').toBeGreaterThan(0);
      // The worker derives these from any 32-byte root secret; compute them here the same way.
      const phrases: string[] = [];
      for (const h of secrets.filter((x) => x.length === 64)) {
        const root = new Uint8Array(Buffer.from(h, 'hex'));
        const phrase = Mnemonic.fromEntropy(root).phrase;
        phrases.push(phrase);
        secrets.push(Buffer.from(await deriveKeyMaterial(root, DERIVED_KEY_LABELS.railgunDbKey)).toString('hex'));
        secrets.push(Buffer.from(await deriveKeyMaterial(root, DERIVED_KEY_LABELS.depositRecordsKey)).toString('hex'));
        // Private keys of the first deposit addresses (m/44'/60'/0'/0/i).
        for (let i = 0; i < 5; i++) {
          secrets.push(HDNodeWallet.fromPhrase(phrase, undefined, `m/44'/60'/0'/0/${i}`).privateKey.slice(2));
        }
      }
      const stored = await page.evaluate(async () => ({
        local: JSON.stringify({ ...localStorage }),
        session: JSON.stringify({ ...sessionStorage }),
        idb: JSON.stringify(await indexedDB.databases()),
        cookies: document.cookie,
      }));
      const haystack = sent.join('\n') + JSON.stringify(stored);
      for (const phrase of phrases) {
        const words = phrase.split(' ');
        // The whole phrase, or any run of 4 consecutive words, in any request or storage.
        for (let i = 0; i + 4 <= words.length; i++) {
          const run = words.slice(i, i + 4);
          expect(haystack.includes(run.join(' ')) || haystack.includes(run.join('%20')) || haystack.includes(run.join('+')), 'recovery phrase left the device').toBe(false);
        }
      }
      for (const h of secrets) {
        const bytes = Buffer.from(h, 'hex');
        for (const form of [h, bytes.toString('base64'), bytes.toString('base64url')]) {
          expect(haystack.includes(form), 'a secret left the device or was stored').toBe(false);
        }
      }
    },
  };
}

/**
 * Make the browser report passkey autofill (conditional mediation) as
 * unavailable, unless the tab sets sessionStorage "e2e-autofill" to "on".
 */
export async function disableAutofill(page: Page) {
  await page.addInitScript(() => {
    const original = PublicKeyCredential.isConditionalMediationAvailable.bind(PublicKeyCredential);
    PublicKeyCredential.isConditionalMediationAvailable = async () =>
      sessionStorage.getItem('e2e-autofill') === 'on' && (await original());
  });
}

/**
 * Records what the app asks the browser for: the device hints on each
 * passkey creation, and calls to the password-manager signal API.
 */
export async function recordWebAuthnCalls(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __creates: unknown[]; __signals: unknown[] };
    w.__creates = [];
    w.__signals = [];
    const create = navigator.credentials.create.bind(navigator.credentials);
    navigator.credentials.create = (opts?: CredentialCreationOptions) => {
      const pk = opts?.publicKey as (PublicKeyCredentialCreationOptions & { hints?: string[] }) | undefined;
      w.__creates.push({ hints: pk?.hints, attachment: pk?.authenticatorSelection?.authenticatorAttachment });
      return create(opts);
    };
    const PKC = PublicKeyCredential as unknown as { signalAllAcceptedCredentials?: (o: unknown) => Promise<void> };
    const original = PKC.signalAllAcceptedCredentials?.bind(PublicKeyCredential);
    PKC.signalAllAcceptedCredentials = async (o: unknown) => {
      w.__signals.push(o);
      await original?.(o);
    };
  });
  const read = <T>(key: '__creates' | '__signals') =>
    page.evaluate((k) => (window as unknown as Record<string, unknown[]>)[k], key) as Promise<T[]>;
  return {
    creates: () => read<{ hints?: string[]; attachment?: string }>('__creates'),
    signals: () => read<{ rpId: string; userId: string; allAcceptedCredentialIds: string[] }>('__signals'),
  };
}
