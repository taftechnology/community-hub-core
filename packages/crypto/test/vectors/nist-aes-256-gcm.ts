/**
 * McGrew/Viega GCM spec Test Case 16 (AES-256, 96-bit IV, 128-bit tag, with AAD).
 * Same bytes as NIST SP 800-38D worked examples for this parameter set.
 */
export const nistAes256GcmTc16 = {
  keyHex: "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308",
  ivHex: "cafebabefacedbaddecaf888",
  plaintextHex:
    "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
  aadHex: "feedfacedeadbeeffeedfacedeadbeefabaddad2",
  ciphertextHex:
    "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662",
  tagHex: "76fc6ece0f4e1768cddf8853bb2d551b",
} as const;
