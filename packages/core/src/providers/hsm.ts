/**
 * Hardware Security Module (HSM) provider interface.
 *
 * Provides encrypt/decrypt/sign/verify operations via HSM hardware,
 * using the PKCS#11 interface for broad HSM compatibility.
 *
 * Implementations can target:
 *   - AWS CloudHSM
 *   - Azure Dedicated HSM
 *   - Google Cloud HSM
 *   - On-premise PKCS#11-compatible HSMs (Thales Luna, Utimaco, etc.)
 *   - SoftHSM (for development/testing)
 */

// ── Types ───────────────────────────────────────────────────────────────

export interface HsmKeyReference {
  /** HSM key identifier (label or handle). */
  keyId: string;
  /** Key type. */
  keyType: 'aes-256' | 'rsa-2048' | 'rsa-4096' | 'ec-p256' | 'ec-p384';
  /** Key usage flags. */
  usage: Array<'encrypt' | 'decrypt' | 'sign' | 'verify' | 'wrap' | 'unwrap'>;
}

export interface HsmEncryptResult {
  /** The encrypted ciphertext (base64-encoded). */
  ciphertext: string;
  /** Initialization vector if applicable (base64-encoded). */
  iv?: string;
  /** Authentication tag for AEAD ciphers (base64-encoded). */
  authTag?: string;
  /** The key reference used for encryption. */
  keyRef: HsmKeyReference;
}

export interface HsmSignResult {
  /** The digital signature (base64-encoded). */
  signature: string;
  /** The algorithm used for signing. */
  algorithm: string;
  /** The key reference used for signing. */
  keyRef: HsmKeyReference;
}

export interface HsmProviderConfig {
  /** Path to the PKCS#11 shared library (.so / .dylib). */
  pkcs11LibraryPath: string;
  /** HSM slot number (default: 0). */
  slotNumber?: number;
  /** HSM partition PIN / password. */
  pin: string;
  /** Optional label to identify this HSM in logs. */
  label?: string;
}

// ── Provider Interface ──────────────────────────────────────────────────

export interface HsmProvider {
  /**
   * Initialize the HSM connection (open PKCS#11 session).
   */
  initialize(config: HsmProviderConfig): Promise<void>;

  /**
   * Close the HSM session and release resources.
   */
  close(): Promise<void>;

  /**
   * Encrypt plaintext using an HSM-managed key.
   *
   * @param keyId   The HSM key identifier.
   * @param plaintext  The plaintext data to encrypt.
   * @param aad     Optional additional authenticated data for AEAD ciphers.
   */
  encrypt(keyId: string, plaintext: Buffer, aad?: Buffer): Promise<HsmEncryptResult>;

  /**
   * Decrypt ciphertext using an HSM-managed key.
   *
   * @param keyId       The HSM key identifier.
   * @param ciphertext  The ciphertext to decrypt (base64-encoded).
   * @param iv          Initialization vector (base64-encoded, if applicable).
   * @param authTag     Authentication tag (base64-encoded, for AEAD ciphers).
   * @param aad         Optional additional authenticated data.
   */
  decrypt(
    keyId: string,
    ciphertext: string,
    iv?: string,
    authTag?: string,
    aad?: Buffer,
  ): Promise<Buffer>;

  /**
   * Sign data using an HSM-managed private key.
   *
   * @param keyId  The HSM key identifier.
   * @param data   The data to sign.
   * @param algorithm  The signing algorithm (e.g., 'SHA256withRSA', 'SHA256withECDSA').
   */
  sign(keyId: string, data: Buffer, algorithm?: string): Promise<HsmSignResult>;

  /**
   * Verify a signature using an HSM-managed public key.
   *
   * @param keyId      The HSM key identifier.
   * @param data       The original data.
   * @param signature  The signature to verify (base64-encoded).
   * @param algorithm  The signing algorithm.
   */
  verify(
    keyId: string,
    data: Buffer,
    signature: string,
    algorithm?: string,
  ): Promise<boolean>;

  /**
   * Generate a new key pair or symmetric key in the HSM.
   *
   * @param keyType  The type of key to generate.
   * @param label    A human-readable label for the key.
   * @param usage    Allowed key operations.
   */
  generateKey(
    keyType: HsmKeyReference['keyType'],
    label: string,
    usage: HsmKeyReference['usage'],
  ): Promise<HsmKeyReference>;

  /**
   * List all keys available in the HSM.
   */
  listKeys(): Promise<HsmKeyReference[]>;

  /**
   * Destroy a key in the HSM.
   *
   * @param keyId  The HSM key identifier to destroy.
   */
  destroyKey(keyId: string): Promise<void>;
}
