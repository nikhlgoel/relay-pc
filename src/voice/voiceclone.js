'use strict';
/*
 * Speech in a copy of someone's voice, on this PC (used by src/voice-engine.js).
 *
 *   text in the target language
 *     -> 1. a plain voice speaks it           (sherpa-onnx-node: Kokoro v1.0 for en/es/hi/zh, Piper "denis" for ru)
 *     -> 2. its timbre is swapped for the     (OpenVoice V2 tone-colour converter, ONNX, run by onnxruntime-node
 *           speaker's own                       on the graphics card through DirectML when it can, else the CPU)
 *
 * A "speaker embedding" is OpenVoice's 256-number tone colour, taken from 6-15 s of someone talking
 * (speakerFromPcm). It is all that is kept of a voice; the audio itself is not.
 *
 * Everything the converter needs around the network - resampling to 22050 Hz and the linear STFT magnitude
 * (n_fft 1024, hop 256, Hann window 1024, reflect padding 384, |X| = sqrt(re^2 + im^2 + 1e-6)) - is re-implemented
 * here in plain JS to match OpenVoice's spectrogram_torch(), so no Python is needed.
 *
 * The models are downloaded once into ONE folder (ensureModels), checked against pinned sizes and SHA-256 sums.
 * The native packages (sherpa-onnx-node, onnxruntime-node) are only loaded by createEngine(), so requiring this
 * file is cheap and safe in builds that do not ship them.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- the files ------------------------------------------------------------------------------------------------------

const HF = 'https://huggingface.co/';
const KOKORO = HF + 'csukuangfj/kokoro-multi-lang-v1_0/resolve/f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b/';
const PIPER_RU = HF + 'csukuangfj/vits-piper-ru_RU-denis-medium/resolve/1e2f78fc13100abc60bf56264dc2ee254b4c5f8e/';
const OPENVOICE = HF + 'eugenehp/openvoice/resolve/be5196ef50a8029ab820e5e3fe8cb055850d301a/';
// The same two files, byte for byte (same SHA-256), from the repository eugenehp/openvoice was copied from.
const OPENVOICE_UPSTREAM = HF + 'Hinotsuba/OpenVoice-ONNX-v2/resolve/bfc3335585a356228f19df7b1ebf36906b731207/';

const LIC = {
  openvoice: 'MIT (OpenVoice V2, MyShell.ai; ONNX export by Hinotsuba, re-hosted by eugenehp)',
  kokoro: 'Apache-2.0 (Kokoro-82M v1.0 by hexgrad; sherpa-onnx export by k2-fsa)',
  espeak: 'GPL-3.0-or-later (espeak-ng data, read at run time by sherpa-onnx as data files)',
  piper: 'MIT (Piper model); voice dataset CC0 (NabuCasa voice-datasets, "denis"); fine-tuned from the Piper en_US lessac checkpoint'
};
const ALL = ['en', 'es', 'hi', 'zh', 'ru'];

/** file name (relative to modelsDir) -> where it comes from and what it must be. */
const MODELS = {
  'tone_color.onnx': { url: OPENVOICE + 'tone_color.onnx', alt: [OPENVOICE_UPSTREAM + 'tone_color.onnx'], bytes: 157196170, sha256: '896195b84b0cb87a828bb8cab06577e9c024356bc9727b1a8f4174154bc0affa', licence: LIC.openvoice, languages: ALL },
  'tone_extract.onnx': { url: OPENVOICE + 'tone_extract.onnx', alt: [OPENVOICE_UPSTREAM + 'tone_extract.onnx'], bytes: 3364792, sha256: 'e91c2cb696e199d2519ed8b62ca6e3c8e42cb99ca13955dd6e188051486e681c', licence: LIC.openvoice, languages: ALL },

  'kokoro-v1_0.onnx': { url: KOKORO + 'model.onnx', bytes: 325560556, sha256: 'b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11', licence: LIC.kokoro, languages: ['en', 'es', 'hi', 'zh'] },
  'kokoro-v1_0-voices.bin': { url: KOKORO + 'voices.bin', bytes: 28200960, sha256: '1c5a5b983d3d50d8586d437a51f3faa2da7919ce76a013c081e65671a3447c29', licence: LIC.kokoro, languages: ['en', 'es', 'hi', 'zh'] },
  'kokoro-v1_0-tokens.txt': { url: KOKORO + 'tokens.txt', bytes: 687, sha256: '6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425', licence: LIC.kokoro, languages: ['en', 'es', 'hi', 'zh'] },
  'kokoro-lexicon-us-en.txt': { url: KOKORO + 'lexicon-us-en.txt', bytes: 5956885, sha256: '7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14', licence: LIC.kokoro, languages: ['en', 'es', 'hi', 'zh'] },
  'kokoro-lexicon-zh.txt': { url: KOKORO + 'lexicon-zh.txt', bytes: 2365182, sha256: '902bc2d20ac7c449c5ecbbbb23c89d12119c03ed5b8ed27f114f0260c9e35229', licence: LIC.kokoro, languages: ['en', 'es', 'hi', 'zh'] },

  'piper-ru_RU-denis-medium.onnx': { url: PIPER_RU + 'ru_RU-denis-medium.onnx', bytes: 63201422, sha256: 'f0129d8cbd0fef7df16a101d0cd302b25a8fd8bbda7b11af885b1e9f3e974dcf', licence: LIC.piper, languages: ['ru'] },
  'piper-ru_RU-denis-tokens.txt': { url: PIPER_RU + 'tokens.txt', bytes: 907, sha256: '2619c1a9de1bcf928162f40c583caf39368cfd6b2340c7bcad51dc634411ec36', licence: LIC.piper, languages: ['ru'] },

  // Pronunciation data (espeak-ng) for the languages Kokoro/Piper read through espeak. Only what these five languages need.
  'espeak-ng-data/phondata': { url: KOKORO + 'espeak-ng-data/phondata', bytes: 550424, sha256: '4e0288957874029a8c3c9f41a8f517ad4bf18127046decbdd4b9d1d6807ce3a3', licence: LIC.espeak, languages: ALL },
  'espeak-ng-data/phondata-manifest': { url: KOKORO + 'espeak-ng-data/phondata-manifest', bytes: 21821, sha256: '7b387af0702c7cf0b61f0bead68feded0bd8e1620729b0b252e76acbc30d3813', licence: LIC.espeak, languages: ALL },
  'espeak-ng-data/phonindex': { url: KOKORO + 'espeak-ng-data/phonindex', bytes: 39074, sha256: '3ca7b8fa3b42624e4b0f152707e7a39245fce569aa99ea47c055d9e622fcf0c4', licence: LIC.espeak, languages: ALL },
  'espeak-ng-data/phontab': { url: KOKORO + 'espeak-ng-data/phontab', bytes: 55796, sha256: '886f3fa402cb0ba73d483aa8ad000af47a6b7cc06293c75a97913fba68a530f6', licence: LIC.espeak, languages: ALL },
  'espeak-ng-data/intonations': { url: KOKORO + 'espeak-ng-data/intonations', bytes: 2040, sha256: '3f8af65fd3eda9759a10f021d61361c120871f463515229c925995c7f90918cc', licence: LIC.espeak, languages: ALL },
  'espeak-ng-data/en_dict': { url: KOKORO + 'espeak-ng-data/en_dict', bytes: 166944, sha256: '71bd330ba8a2e3e8076e631508208ef49449d6147c17b7bd2b4b1e1468292e35', licence: LIC.espeak, languages: ['en'] },
  'espeak-ng-data/es_dict': { url: KOKORO + 'espeak-ng-data/es_dict', bytes: 49252, sha256: '3fa93e251eab80838a2d6207ee58c9c847270a65fe3fae98850e0185b5a2186c', licence: LIC.espeak, languages: ['es'] },
  'espeak-ng-data/hi_dict': { url: KOKORO + 'espeak-ng-data/hi_dict', bytes: 92143, sha256: '5a68c9532624e57ac845b26ce1e2e5034c4f6353bede46ecbe57e583ec8effd6', licence: LIC.espeak, languages: ['hi'] },
  'espeak-ng-data/ru_dict': { url: KOKORO + 'espeak-ng-data/ru_dict', bytes: 8532392, sha256: 'f0f6181bbbf9e53cd1e8f9d26bde8fc62119c4f78181948f961cb29866e5e585', licence: LIC.espeak, languages: ['ru'] },
  'espeak-ng-data/lang/gmw/en': { url: KOKORO + 'espeak-ng-data/lang/gmw/en', bytes: 140, sha256: '4605d5330801de3641c6e366d15f129ea1f5ffbce8722642aba01ace07ab9c83', licence: LIC.espeak, languages: ['en'] },
  'espeak-ng-data/lang/gmw/en-US': { url: KOKORO + 'espeak-ng-data/lang/gmw/en-US', bytes: 257, sha256: '41534c2a22df5dd4f1052ff9e1a33a3ea7bff5a26b5c02bdad5ba8ddb7524704', licence: LIC.espeak, languages: ['en'] },
  'espeak-ng-data/lang/roa/es': { url: KOKORO + 'espeak-ng-data/lang/roa/es', bytes: 63, sha256: '966aa015ea5646d79f0ca4807cf5da7339aabd3782b55cfa5eb0d8c3fc8fc588', licence: LIC.espeak, languages: ['es'] },
  'espeak-ng-data/lang/inc/hi': { url: KOKORO + 'espeak-ng-data/lang/inc/hi', bytes: 23, sha256: '3c1c3f916f57f2d6d6cbf7923c0f39a36ac2140e2a69ddffce917d7b8bf3ccab', licence: LIC.espeak, languages: ['hi'] },
  'espeak-ng-data/lang/zle/ru': { url: KOKORO + 'espeak-ng-data/lang/zle/ru', bytes: 57, sha256: '9f52d00a279aaeaa45a786b4fd3a98b34e95fedbf823f8cdb9fecc1339751d3a', licence: LIC.espeak, languages: ['ru'] }
};

// --- the languages ---------------------------------------------------------------------------------------------------
// Each supported language has base voices; with a speaker embedding the base voice whose own tone colour is closest
// to it is used (a deep voice starts from a deep voice), which the converter then finishes. `se` is that base voice's
// own OpenVoice tone colour (the converter's src_tone): base64 of 256 float32, measured with this file's toneOf() from
// 20-28 s of its own speech (six everyday sentences) made by exactly the pinned model files above.
const SE = {
  af_heart: 'bxB+v5vEhL1yBz09E4iQPoXvAz94ti+/pLjAPQ/J+r7qRQq/JRYGv/xdjD1ssiq9TlElvvN6E7/aV1I+ZudZPw5iWjzzzQm/sVZPPyAduL6deWG+uETXvqG6FL59LM09IUdMvpkbET2tGjs/C4NvvddLnD0cLsu+jBEnvdB4a703R+m9ksOYPyVDLT5Zapi+P9dIv62MMT83UDi//hagvS3W671tJRQ+72Yhv+1VrL/OGAa+6fjhPdZiN8C8biI+YVikvu0Ftr7c1zQ/bpPEv/eTEj+SiQo+LXUKP5c8hT/w3Hu+/ec3PyIRp75NM4S+3RcDvZnPPT/lcWS+z6z/PhMFyr7EOta+cCDFvlfUrb8sPMQ++O6uPv5RDsC+4XE/C5e2PWtVQb9YTco+Pxk3P6dcl77g3BK/qmjOPoxlMz8SCce+n00yvQzprb5FHw45KEWqPoKFJD/EOQQ+4FMhP+RRoD4Vk4K+PEwBv/gYZT87VUS+VeimPe3gi73re829CljkvcgLGj4/3WI9+MFwPeq4FD6v5+q+SMpfv7dYML/r0og+Al+QPW7OJD9hFp2+BYY8vrgV/r6vZQFAwC1tvnZsSb2ajTk+ebo2PxS13b7XHpA9mc2kvz7QtT7lMSc+bup0Pi7wuD2wHMg+FdG4vwJaN72fVZvAEliEPJgnSz9/chi/EGCoviplhr4DWiw8/umWvauwL790JqW/20I1PlDMBr+WgoW+pdEaP+cTmDvcR/q+0J0DOsjQiLwS0HE85YWDv17BWD9oy1A/2SP0P61H2b4+xMo+nea+PjpvLD4DHn2+zYbrPjw+7r2dN7c+5KHnvMdiuj6oH1a/5M9vPgf2mT7X2gS/jlyYv79Wlb7t3SS/o99cu2dWiL131oi+KhcUPhZdPD/NqC6+47kEvxNDpD56OmI9CBQgvmNe4j5m9wK/Dgh3vXCOXD5Ajv0+sb/fO038TT/YMxo+bHmWPn0i/j6JB40/7YsBv5TMgD8PSYc+XPI5PlgVyb5IP44/hm98vsH27r7n5vS+nX9svydiCT9FRGA/pD5KvltyY71RKCU/PcuSPpE7qj494hq/Dk4gv93sQ775tIO9csuzvcFpTT+4q5E+aDy5PopUhz33+lA+FZgVvNdy1L45m4E+/ZH6vazAeL9rgzW/aI4Xv00Qwb75vBY/hr5uPquTeT7snOk+plMUvnikVb+FKH4+mmOwvlPGlj2j30Y+CtujPjVZDj4aNn0/bMu9PqvN178n0iM/qFT/Pmj0Gb+lnYC+WskjPwisJL9lcJq+GsH6vmmdiz6ScrG9i5LVPqO9I71WdrM+/Ej7PggrZb+kIyY/GRgOP6mqqD6Mnim/rvtLvg==',
  am_michael: 'txiCv1kZTL+eHVg/qQr2PfJkWD5npIS/j0FyvhuCkb/YSQs/NAuxvvxbjb5F/Du/0G/CveLKMz/KdaC+LETzPrcIaL7M9iC/3/8Zvwvd2z3ca8U9z59dP0YABj/a17A/5tEhv4jF0b4/iGI+uU2fvVRIAb9bYRo+vEjIPkGY4b5DVSS/R75xP4HpHz9GLZS+kwv5vr2xtr8QD749Na/CvohEobze4qQ8o3tYvPFNvr9Hc9C9TwsnvkyRSr8Qz7U96Rd5vl7SLT9GuYg/+1ILP96wKT+KkQI/n8pVv/L/yr7Dkrs+13hsvuNXNz8f/EG+X+UgvfpIpj9RIig/DewvvhazPb+PGAq/7hG/v/H8BsDk+Z48gVarPggIF8Dw5mQ/yHLavUUSVD1NQSo/AOa0PjiKoL6qMQI+POORPu5FmT4O6Ds/rO90P1psG7656rS+uPHQvr+VBb+TrUc/PeEzP1jeMr9zpNW+8bigPbXi6zzobzQ/r7unPiIJOT+cHxI/YqplPo9njb43lwy9+fZZupj2CL5o+Zq/6Hlcvpljpr50ZQE/woD4vEMNjD+VZbW+276svwMi6D1kVgTADeFMv0Gqbz+KdGo+yAm2PpcCkT3peOO+awYlP3jfKD6sAeI+4D5PvqNdur5rAgu/07++vvG6/b4Qoo7AsfgdP+0p1T7h0SU+2H6VvjC67r8s0cc+UiGpv54RLj5TVp2/yqcvP1GkC78lVhq9f3SSPlzHn71Qd4+/s9ZXv9YHOT/TIYs94U/iPA24jD9wDTC+HvZvPqa3gLuorAK/HgI9P8n/Cj9SEMa9CNBKv90apb4LHQ+//iuSvTvElj69mvk96f3gPlSwab4gtzu+UriSvorLb77xLVM/rurpvlsN473jooq822O8PT2FsT3WONa9FlDbPtxGvj6nkoO+s5geP85W5T5H3Mo9ruObPtqDGT6aeRQ/9LPQvmoSLj8SGPM8swD0vhh6ez0dq+i+bFQiv7FnCD+0NDw/pRmmvY8sgD7ygMs+1Gp+vw1xzL43RDa/9l1iwCdjhD8mlV49rqSyPbLICD0dyqE+DGSUv5AQr76p5py9U2XSPh3CZz8j+wG/dEJGP4mQUz5V3sO+rw8aP5h90L54e9Y9+iVoPzJe0r7PUba+JI6Dvr17p79ypqQ+V5NTv1VaEj/OWEG+qaY1PxJkIb6Dp+q+cZB3PwGNmb7RWam+R5OJvrXETD2HPxq/n6ZAPoBW+L0CsbQ/yWCZPviM1z4N+xQ/vKkkv6nBEb5Eg3Y9Ts50P6BdVz4S/S6/O8Q+vnp54T664wW8rotPvz7G070ehYk/UGBMP83/cL+l9Ca97RtLPzra7L54FAQ+n4j/Pg==',
  ef_dora: 'IIWIv0gp7j1cx/m8juzXPlwaDD8XpEc+bH/zvpKhHD63Bpw95w2vPrLKD7+Ud+m+JVZMvGisdr4q3s69cY02Py0zuL6zEdG9pEcEPwdp8j7yh7i+xAsYv2IDFz1sGpC+PFSHvd4fWr62T/Q+/yWtu2JQxb2XSPW+Ctqbv9hMW78W7c2+WDGePv+6QT+1Whk+0e7yvgwbRT6cHTK+omrHPLVySr963ZA/3dXhvuvSu752+6U9PPSGPuOC7L9NGkQ+n90UPfg9Jz7J/5w9dzeev/f2ZT3Jfdk94XNnPi/ftb76KMw9/UlevqzGlL9JN4O+FtPMvlHIGj/hrTU+SEBMP9ZiPz49cKq9Aq6Gv6YkcTzsGqk91Cy8vqKPCMABtSY/I8hTPvMUmr5VrlG+P0WDPdaNDr7DPGC/JVCIvR+VNT9E9vc98XkUv1ibET+Oste9qNyTvq84AL+BnTw/Kv/Kviigsb4hyoq+lXm3vu4IkT4mvtA+juCuvpLhMT9xiQa/n2lAv7R2h7x2lPA+gJdJPutVQz/rhYC+xYmzv3L0FL8hHmU+FGiCPhaAVT624ag9E1VfPg/YHL49BMi/trSCvdCFWj+amoy9OTefvpOANL+BOhm+g06OPibGaT8T01u+S7UeP9JZNj8y+RE9qVq7v0yQlb4zpZTATNsCvqFncz9kehs/RYtiv72u6r89n8a+2cKtPrslUL83l8u+3BEhPsCunL9c+PA+mZmPP2dljb3SHAI8pksFP0UgBj/fNQi/wXZmv43IMj8n16Y+MCTNvI3dvD5Lj5y/nisSP2SDBD/XHBk/Dzxdv8am6rxnMo490YzFPgP9ez6z5ga/udZLPknO7b5WqZ0+E65bvvqtUL/ZlDg7Zqv0PLZVED9MEX2+faqMvvVmkD8ME9A+qnWVPTq9br7edOs+F1IsPsMTMj7e19M9Wm0jP/5Eib7uk/K98bWrPj36cT/wHf8+qUTNPiH92T4Mz9E+cxQAvJMKAT+Fhjw/eJqiv2eLPb8kS1c+YbIovnfcJT5QR0u/8Xe3v5bkxT7o5Ti91bctPxpEXT41WZs9ybihv4YkET+AOBk+hJyJPv5Ayjw4Ulw+EJtHv237i73N/2G/tifPPcw9Ib8Ua5Q+xpFNPpPoer7Rzcg+Rx+7Ps6Rlr8c6hy/4CNdPFkZBL8IyhM/iVwqP7GOpr7ZonS+uzcAPxFDOL/SLN691MJhv7l/7L4o9YG+6ZeHPGudcj5q7LE963NmPe8CTb+RdDo+kbNzP87Uer5NbAS+2mNmvrXK3r6THQ89Yj4gPu37Xr55Zyw+CymlPm98Tb6CMLE9+Vi2vps0Wr9dzxk/f6ZhPrbRZb0q3NO7KEnnPg==',
  em_alex: '0y28v7qlgj7h7vw+kP0VPrfFzD3PhrG+1fsVv8KAwD2bz3m9ld4Kvq23Wb+2YBK/bmG4vNzVTD0RT72+LVUlPxFjqb7s5eW7E4VUPmX0gz9HYIw8C4SHvtfTBj7ox6U7pcI4PS38B7/ZhBg/z5RyvCGghb50MBm/cXplv7YGUr/bVMK+72ERP7pBcz/Y8DE+aK4qv8tuBL0PobW5SwgsPamIOb9YCJg/w6mVvkKbx762zga+ZqfKPNmxTL93PhE+GWkrvhNlar3A5fA9Ohf/vEincr6R86I8X37+vXyXX79d0JQ+5FaJPSx73b40ZNi+3YICvynbhz+dUE49URu1Pj8Br75eVjS9fmaxvx4uL77WCTw+q12tvhFuIsCBH8I+K2vqPs8fgT4EeZ6+aj/uvZdt377jkgG/gKbbvW90sT6Sydy9W1MGv5EkLD942wo+iRLJvs7eG7/zhIE/tKT0vvKSiL5IY46+EX0Fv8B+Dr7yRww/i0GUvSdwfT+TrLY9/cJXv0Z7UD5BTkq+6rYKPtUWBz8Pn0u/aBx3v6AQZr4RFnM9yWWIPnQ0ET9J0QY9hRU5vugu2DwuU0DAak+Evt6ttD/rwxk+qSesvph6EL7EsQO+lhlVP1EqLD+isCA+qcXyPBdcZz4lCRC+ezaDv+/VOb4ux4jA568iPvMojz9PuyU/CdhPv/abG8BtJ6K+QFgqvpiGNL/x8GW/TQjgPtpPmb9rucI+fqCNP3XmoD6NSas7ptASvZR4GD5DgjW/QPnGvlrvuj7j964+er+0viu7nD21QLK/yY8VPzpGbz87awI/8+BEv+WDBb0AUpG+hZd0PigXzD5Wylu+m2/gPvA07b4kbL08t3yNvTlQJr+sxuA+X9+bvj5w4T7Xds+9JBkevy9qPD9rPZA+NlrfPpL3wj09bS4+2II0P+/DlD4zazU+GKtJP94bCL78yYE8ZBomPjF7lj8p94c+CJdrvuREoz0/zTw/RolpPuVHRj9lQpI/lK2kvz6BDL+q9us9H0fHvgh8OL2jW8e+TSwfwGr6wD5D9NQ6cjVFP1jnyz66yo89kDW6v/YcgT6Pa3c+3ILJvTWQvTxmTCg+yH81v3JGhT2hCGG/i7l3Picbdr9qd4U+k9uYPEry7b2HXFc+zDMIPlaEsL9VdP2+Bk3kvj1wu74qYRI/migNP+opBr9Mcxu/6fzaPiyTB78QVIW+xT8bv85zyL2xAii/lbzyvP0g3T1yOdQ9VLRQvczCLD1L6tk+w75bP8qUXr5gs0e+DfLHvQvQ/b6w5Je+Eh9JPsSGor7yS/8+vj89PrbGPr5kY80+QVYQviSTgb/btvY+HfRPPcCSt76zMaw+fIwSPw==',
  hf_alpha: 'yPZ0v1lgFb0pkoE8Hw2XPUgXXj/L8S6/FJZevjhBOb/GKb4+byeVPtnBr70wSYG/rRlSPhqOOL791WG+orrDPxLDDj/Qqdc+/hSLPx3BH7412zM/IcrdPm2Ie7+MyIw99W3JvcadO7+bsco+OPLdvA8Gsz2FxBU+misdv4/p6T7vGOO+G85RPwjljj/TDE2/WEsWv5ICGz8fTDO/uA1bP/pdFr5JIbc+pxdZv+eALb5B5pO+Pgd+PRxOIsA3lh8/hBZtvyvW7r59axU/uVHKv6SSkz6N/MG+UgZXP0Zgkj/5kTa+JytJvnYmub/eZgA/6pUBPtPN976d8TS9tCeDPNdag741ecy+DrTFviSKW794wCE/bvTqPRhTib97hk8/Bfe0vQwBrr7qRNS8tYV6PzFtiL/QCIq/32kqP9Kwnz/XHym+t+bvvhGwCj+9f7S+hx0hvy67zD41iVs/XQ+yPCdF1r6EADU88+kQvyZ2hj+erDS/Qu6XvpxynD1L9mE9My/Uvl4RFD/bqpg+ULsCv8bGNz+s2xW/kH9Wv2FftL5WoDc/c2icPnNfqzzVklq/gIaNvuKi/77Zr6U/UmE7vtQEGL88CMi+4s8aP6ezz755wJK9Andnv90TRz8ozwC/Ju2QPibNaD8oUME+8/4XwDb5nT7Dj3/A5ByfvTXySj8AERI/ySxJvxQc9b0o6dU+C3/gvs4EmL78MqO/lfdiP1zbBb8RPgw/Az2QP+cgBT9qvCO/QMyVP+cvMD7F7Re/mP5tv+f8lr1jHSk+bY+0P6RDvz3GUVM+sRmrPlHKEL0uaXy+unKMPuCU8r47N8U96eaiPp2ulT6xh6G+P7DzPkYky76syK+9Bh6ov925QL9F1wm/erwGP9zcirxPFVk8eyMYPmE+HL89F1A/e/0wPmTxXb78UpA7/ZeFvcFCQT+hZNE+2UavvQO61L5tDSk+gbobPwW/qT/BBXQ+pFYNPxfxFT+kDs4+dVlOvrBT1T5h/S8+MSIuv4r0I752TXQ/dTgDP4Rqvb3weQ2/My20vigiYLwsiUM/LsljvtG8sb4XHpo+MK1Kv8ZCDz8vi6u+BuEUv7p9iL5Gi3E9LDHJviCtkj58nyi+kNI4vsam0L4k7Kw9DLTWPmTUNL/pAAM+BMtHPvaR+L5y+IK/ARrvvn5MSj5LVVw/T0GmPXneoj1sWlA/3lcCvy/pW7/aXJ4+D7qjv6UZ3b5wWp2+2CIQP0qPur4N1O0+7AUePj9kv7/HGkA+VXPJvoFHxb6uVVg+OCAuP33ZjL+Cghu9gyGuPfJinL5VXrU+N+E0PiCHNL8jbhG/+gMPvX4xur9qrZY98fKGP5N/776fTLq+ZAn/vQ==',
  hm_omega: 'ZEDVv/w6tL2YZIw/LXuyvRFc8j6Gs+2+jSSpvhlO9z2tlZs+RP24vuOMP7/D+WW/mI7kPB4v0j4/5hY/VgOGPwgsVb29UpU+YSimvn4hNj4qNho+nFLUO6uYrr7Y3dc+K0TMviiSl77tMCk//0UjPWLRuj2WJ6k+kmXcvv6Y5b7ROxm/wLN9PlRdSD/S6x+/c04Dv9gNJL+yHso+j7DjvethHL5cWWg+f3muvZHcU7/BH+G82KmIPkXEar9zLw8/z7Shvr33HT9SEOA+hrx7PiWkAz8NRxq/O4tlPsr1Jb9hDK4+QYAwvzBfxL6iBhK+jjadPoChdj3TIhA+8Jymvo5Tjr7D6Yu+UJbzvpIdi7/Ej5y9VkybvjmuBMAixw4/dauWPoQPAT7hR0E+Ey5bP/7HQL+TAkq+zUxOPo8rVr6iPco+6gVFPsnbRz/9x4W/XMXVvrmCg700cNk7BymXvj1kFb8M/+e+E4zyvSYwab1skBc+DFfmvgnEST87oEk+OFBKvyf0Ez/j7+4+v44/vh1gdD5I5G+/wDY9vgWEp77tpS0/v7uiPs1r6T7WbKq/H8NKvmBBn7ps7xfA/DsgPjiPXD8rYku/jjhqPlSvlb6KYyy/gOdBP74Ofj4jG56+AvQlviVbXD4NYpC+6Sbkv59jJj4zv4bApCsDP/X65D4uJrE/tmUMvxwZBcDx/ps+A088v0l1vz7zy4q/Q2wWPxLelb/qNwc+xodTP+/NAD/9GGy+TRJBvUsRiz3AsIi/xFRrv+EVHj8TMPa9ivCMPfFcOz7065i/pzcaPmeq5T4mh+Q+5j+VPu5xoT7NiBU+yorXPoN9JT8T7tA+XOJiP+DjKb8Y27G+FCImPVIllL4nDEc/4LMnP/TyDD1p1uK+iJcCvvHbAb95FBs/08WYPedyrT4iVmW/mVP1vvmj6z4cqeo+65InP6lCZL+vwBg/ReiBPgSTbj9YhFk+wCgjv/PXgj5PAQM8B2z+vUwdHz24Aho/oUiUv6YR/b51IUw//HrMvROWHL5CESm93mA1wJj0VT4IkQY/QSlrPgiJHb5wlE4/9r2yv5lFyzsX0UO/qUH1PhP4BD67EUy+o9HivpsfuL1m+kC/P8LhvpFhGb97+lM/FfvnPTunr778Ryk+PVT8PbFGc79zAka/dc2nv6gW8j5idXk9S6NbPVHPDL50IAK/geQKPwYHWr4MBhA7iRBbv+aSHj7knBq/vjQBP7BCur6aipw9LVZbPBufZD7V/SU/L243Px+qjb7Cnf+91ag8PsBiY7+5kbu+vrbiPltsrr7HFpA+TVOuvhfpBb97BeI+unsXP7fIV7+v0KM9fLXbPkmNEr9Zfcs91nOmPg==',
  zf_xiaoxiao: '/p+RPjMU6r5n12E/+u4mv42xLr9Fo9i/zEcWvzniFL/EP689k2lXvy5QKr2yWEy/UNuAvobIPj9f6a++GbuIP0Xn9D4s/Fe+zGDFP5pvD7/jfsE+w9PAPtFIGL9SRks+jWUOv/nzGj7HEaE+wsxfuh+ejj4e+Cc/E6AuPmQzjr63Rtc+lWYPP+WCYz9ttAG/inTEvnfZSj450EC/ZjY5PvMjKz4aqoE9QGd3vr8y2L4VKKg+71TfO7rRF8AwmjA//2xDv9p7O72Cb/U+6nntv8oGxz2+aqE+IYxIP3xqZz+hdx49Jc5JPeIR774t8rw95aRnP8QMrr4eloi/qcAAPwMhET4kRXi+QebBvvq6dr/59O08BOd2Pv9JQb9R/k4//mWUvSFUqT2ijru+AiZIPyTY8L7RysW/I/PwvbsGeT9LWfk85Od3vQ0BBD6O7ka/HcIEv6bgKD1FxlS+n8D2PiRnpj6W1cC+af1GvyVaXj8QL0+/b653vlbGAz96p9g+B4EYv9wqCj4npwe/A/xEPuN4AT2XKaC+xzchvdvHar+NfWY/Cj1pP0r3Ej+3K02+SrovvtnWkDwBES5AwEkrP5Y4D78sSOu+pbjMPEzaU76VdTm/+JsYvzGyKj/1qwI+sZDaP9O+lz0RbqG9LRdIv2Edyr3HIFnAQy9nPyiewD6EBqA+0dmJv/RG9j4k86e8263pPXxfQz7ynhq/qnVwPqCgUT63SjO/HHJzP7mxiT6CcyC/e0F0P6mb4T7FJ4I7iqtHv7MjWD/Egis8I64jQKm4Yb+sICU+dY0fP2I2kb27o0a/zCdGvSuSdb0/E2m9SX2Bvg+Pxb7+cx0/UJ7KPqBqx72uB7m9Uu/XvqntL79t2y0+fW8YPxmIz715yU6+VYI2v0ojOr616zA/jLApvzR6/D6/qEY/mjmKvrAmGj//K4a+SR0qv7O3ML7ppxM+w1KWPlXKbj6geRK9jY5RPk4GiT9ISB8/DwAmPuucnj8HAg69q9ZavuWTEL/ANLo/oy8NPxhkIL+nmOa+P+Wuv+xrN76cC2m+7C//ve1KOj67DsM+4wA+vgkIrj4nhYS/5yilPhMgi76Yw4E+IVqNvnVKpT52DIW/FpTYPkbHIr6ni08+h//VuzaMIz66g84+HSgCv1OffD3Eh2q/0x8Dv3vAoT4Bfyg/4jLKvseE7T5opi8/7RKXvrnMNr+CTxs/GguBvkxu3z4sc8a9JLHVvXEKhL+2KYQ/gxGsPkASpr+ARRs+H+mMP/PVCL8Dm0o+NWtZP1Hks7+s8YW+nEskvhVZrD1M1pA90VGvvtZaj7trl4+8cpFfvQVSh791Pe8+z++RPxSjsj6AztC9ETYbvw==',
  zm_yunxi: 'Gy6Bv0LfTL8N6e8+8PMAv/zI/T4bJY2/e1+kvivwzL7BLFU+/sqIvjq8mTxUdAY9+06ivbtL0r2y2pE+bY3WP0gcPz11m6a+lc66vEDC+r7edJU+LV3RvgmRpL47+o8/hrRnv5A1yL1sVII+7Wp3PnPJpL0ec9s+XrCfPoHjQ787RFK+m69+PznF5z49CJ4+fRlCvwCviLynK0e9R7BjPzRzj757J0Q/8JcGP+KkRL/Bs6c7ibiPPrUlFMBkcp8+8irVvT3sXz+wUkQ/fMPkvllOOD+1PVa/k6dOP7ykIT9e5FI+CAkZvy7R+L4/5WS/nUeDPgPScj6B96m+y/BUv6O9R74MwCq/AfWvvnqovb9zN32+uUK3Pj62B8CrAJA/RCMpvwmGs77Xogm+jk8BP+c6gL6KslG/fqqEvnh+DL4VCHM+MIHGPEQJgz7sNwK/IecMPnGwWD5Nbvm+0KY3vqKnUj42Bg4+yLHuvioJiD7LNuo+So61PSOxtz7TiBw/IS+FvmE+FD7zma6+6RIDPHZF6T6Kyy2/qMCCvliGJ7/BlOE+YYqLvlD9mD95LU6+XhgwvsKYX7+Rph+/fRSHvkb5Fj+XZzq/u7UtPjhKtz4CbCI8TU6cvnTNIj8E9pi+h06gvhcqaj48pPW+oMdVv2UYlbx0i4rA6ZAcPhxegD6+pUU/hS7bPW9NoL/YwRu9ETVSvhGG+D4MrY2/rMkrP43hdr74yuS+dxHuPvRfhLwBSBY+q6D4vuIn5T3CKZO+ZSByv2z5ij8mAOs+XVIQP+0lwz4AZOq+m/eSP11LnD4AOke+XiD0Psd4nz66RUg/RowFvgafer53ka2+EDDEPk1qoz7J2/i7iA3rvjZ9577Uvwc/SGwKP2nbQb8Boku+9+jNPQ5Qtr4m1Ww+S++KvjBIyz78sgq+9yfwPeQKjD6mPIs+MKSaPcB10746zEs/RYu+vfb8jz/sOlg9O2UlvXDbub41BzE/Exoqv013MT/HuO8+uIt0vtHMl748Z7U/w8m4Piip876bhg6/cRfOvzpdkz/ayhg/iKBzPYqppz4twwu6YjF4v5fykb3EhHs8W6AjP+Kgsr3zADy/fc1uvNvfWT9KLz2+UUwHvtLNMb/isCU/CEZdPwvyi70A1q4+s7rQPg8+hr8PhL49h28Yvy7RR75cCAo/8/yNPmcTJL6N1lS/lLYaP5TDbb/WwP++Yng3vy76TD4dcQW+1YOmP420q76FZCQ/KmhEPdLLhr90iJc+XpvcPcPsJL/BNgC/tiTzPk3Ior0Csl6/5qQUPvfHBj8k9ow+kFSXvrQYkj4HLzg+8cc1Pdrr6r8fXWs+dCsNP9IHpj0uh6c+FLkUPg==',
  denis: 'grQLv7zEET8V2iI/tyiOvrhRrD8Aghc/IIHFvRWmmD5GTgm7z6hOP9CNPb2yef4+FAh7Pmgpmj8yV4K9mjfvPLPA6L6XWqA+P6J1v5EXD77t5CW/+us8v206d7q8m1U/QtYUv3B9or5UFVS/xkIGP1RcKD93ge098eIMv3Snbz4P/jG+lXs9vmcKFj+I1um9OEikvZvUMb7raZ4/uiq7vA13Sb/iHQe+p0QKvsvZm765DoW+16VfP9oWub5mUzC+KsJYvq1PrT8r4dM+glYiP/JMaD+vl2m/9qrHvtqug79soj0/esADvxo6A78U/1k+eNMVP1CCR79X38U+U227vmyJyD6RIy6/adotP0CfFr607zU/ky8wv7a7z7+8xQM/biHePhyGl73CpdQ6IUsuviO4tT0KoQY+VBOQPoAKCD/1may+/WCGPkP/gz1XKEU/gMrKvldZjr7BQLi8HrgOvWPSjz7U14G/iwJFPqzbQb24fZC/sCPEvnCdGD5abyc+/YooP141QD2fZAq+eJOBvuARBz+3hBs/OwgMP2cCUr0Vfiw9JobsPnijPT6bw0a/GQEovtJovj4JnzvAzSELv1IXSD82sbG/EYziPupNQb1TFyW/d81JP5Y99D6BISu/R0PwPm3qlT5uNbi+1MDGv8wLLL9RbanAchEuP4iI6TwXhqo+jFKCPyvPJsAtf3i+i3KavjNRQD0TRXA+cKWAPtMY6L5xVFK+o0VgvQtchj/WgDI/KC62Pt3puL6CUAU+tgAbPaxHCD9wVNE+UeHPvuT0Kj6QCV6/nWJyvwGyz70Xe9o+vhpZv2HduT5uJ+49rmkHvgGBoT6ADNo9gA+OPlXYmL4Z83c9Hz2Qv3Lnez+x7C++AtT/Pk68DL8Y0G8/ChJevh89n75w3Z8+f60Jv2ss9L6K+m8+UJIVP542O792BdC9zb6BPcjG970HkZs7058evHlcazzV+aI+0T+4vvCVMj9TXow8+MH1PYUV874pY1S+GdTQPiSVyj7uDQw+THviPuIzhT4w9Ce/Kk6jwIALCb84YtC9aKZXvhtuBr9CejC/dXpVv63/hT4jcQS/6CGzvqzwXb+MT8S+ZwR2vyAxpD1aH+a9kQJMvjmaEr8+6c8+ycizvcfKgr4Tt4E/Jw8kv5WMR7+NSXC8IvXmvvtSLb8HxYS/sJGuPSsHUL5+3tK+to9tPkMFpj5VRA8/pY8bP7DWYz/hkRM//qWjvpXH/T7Q7dG99Q45P1tQmD/Vbfo+rQt0v09aOj6bVxC9SNiAv7AXUD9NtwC+YMjfPsS4AT9porw+oFoXPoVZAT5yYOM+W9oePzF1Ez7TmPO+SYU6PehF+D7VcAA+Aw9gvg=='
};

const LANGS = {
  en: { supported: true, engine: 'kokoro', kokoroLang: '', voices: [{ name: 'af_heart', sid: 3, se: SE.af_heart }, { name: 'am_michael', sid: 16, se: SE.am_michael }] },
  es: { supported: true, engine: 'kokoro', kokoroLang: 'es', voices: [{ name: 'ef_dora', sid: 28, se: SE.ef_dora }, { name: 'em_alex', sid: 29, se: SE.em_alex }] },
  hi: { supported: true, engine: 'kokoro', kokoroLang: 'hi', voices: [{ name: 'hf_alpha', sid: 31, se: SE.hf_alpha }, { name: 'hm_omega', sid: 33, se: SE.hm_omega }] },
  zh: { supported: true, engine: 'kokoro', kokoroLang: '', voices: [{ name: 'zf_xiaoxiao', sid: 47, se: SE.zf_xiaoxiao }, { name: 'zm_yunxi', sid: 50, se: SE.zm_yunxi }] },
  // Only male Russian voices have a permissive licence (denis/dmitri: CC0 data; irina: unknown; ruslan: CC BY-NC-SA).
  ru: { supported: true, engine: 'piper', voices: [{ name: 'denis', sid: 0, se: SE.denis }] }
};

// --- DSP (pure, unit tested) -------------------------------------------------------------------------------------------

const SR = 22050, N_FFT = 1024, HOP = 256, WIN = 1024, N_BINS = N_FFT / 2 + 1;

/** In-place radix-2 FFT plan for size n (power of two). */
function makeFft(n) {
  if (!(n > 1) || (n & (n - 1))) throw new Error('FFT size must be a power of two');
  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const a = start + k, b = a + half;
          const wr = cos[t], wi = -sin[t];                       // e^{-2 pi i k / size}
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  };
}

/** torch.hann_window(n) (periodic). */
function hannWindow(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  return w;
}

let fft1024 = null, hann1024 = null;

/**
 * OpenVoice's spectrogram_torch(y, 1024, 22050, 256, 1024, center=False): reflect-pad (n_fft-hop)/2 on each side,
 * frame, Hann window, |rfft| with +1e-6 inside the square root.
 * Returns { data: Float32Array, frames } laid out [frames][513] (time-major) - use transpose for [513][frames].
 */
function spectrogram(y) {
  if (!fft1024) { fft1024 = makeFft(N_FFT); hann1024 = hannWindow(WIN); }
  const pad = (N_FFT - HOP) / 2;
  const n = y.length;
  if (n < 2) throw new Error('Too little audio');
  const padded = new Float32Array(n + 2 * pad);
  padded.set(y, pad);
  for (let i = 1; i <= pad; i++) {                       // torch 'reflect': the edge sample itself is not repeated
    padded[pad - i] = y[Math.min(i, n - 1) % n];
    padded[pad + n - 1 + i] = y[Math.max(n - 1 - i, 0)];
  }
  const frames = Math.max(0, Math.floor((padded.length - N_FFT) / HOP) + 1);
  const out = new Float32Array(frames * N_BINS);
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N_FFT; i++) { re[i] = padded[off + i] * hann1024[i]; im[i] = 0; }
    fft1024(re, im);
    const o = f * N_BINS;
    for (let k = 0; k < N_BINS; k++) out[o + k] = Math.sqrt(re[k] * re[k] + im[k] * im[k] + 1e-6);
  }
  return { data: out, frames };
}

/** [frames][bins] -> [bins][frames]. */
function transpose(data, rows, cols) {
  const t = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) t[c * rows + r] = data[r * cols + c];
  return t;
}

/**
 * Band-limited resampling (Hann-windowed sinc, 16 zero crossings each side, cut-off at the lower Nyquist).
 * Good enough for speech; exact for from === to.
 */
function resample(x, from, to) {
  if (!(from > 0 && to > 0)) throw new Error('Bad sample rate');
  if (from === to) return Float32Array.from(x);
  const ratio = to / from;
  const outLen = Math.max(0, Math.round(x.length * ratio));
  const out = new Float32Array(outLen);
  const cutoff = Math.min(1, ratio) * 0.97;               // fraction of the input Nyquist that is kept
  const zc = 16;
  const half = Math.ceil(zc / cutoff);                    // taps on each side, in input samples
  // A table of the windowed sinc at 512 sub-sample positions per input sample.
  const RES = 512, tabLen = half * RES + 1;
  const tab = new Float32Array(tabLen + 1);
  for (let i = 0; i <= tabLen; i++) {
    const t = i / RES;                                    // distance in input samples
    const a = Math.PI * t * cutoff;
    const sinc = t === 0 ? 1 : Math.sin(a) / a;
    const w = t >= half ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * t / half);
    tab[i] = cutoff * sinc * w;
  }
  const n = x.length;
  for (let j = 0; j < outLen; j++) {
    const pos = j / ratio;
    const c = Math.floor(pos);
    let acc = 0;
    const lo = Math.max(0, c - half + 1), hi = Math.min(n - 1, c + half);
    for (let i = lo; i <= hi; i++) {
      const d = Math.abs(pos - i) * RES;
      const k = d | 0;
      if (k >= tabLen) continue;
      const fr = d - k;
      acc += x[i] * (tab[k] + (tab[k + 1] - tab[k]) * fr);
    }
    out[j] = acc;
  }
  return out;
}

/** Drops pauses: keeps 20 ms frames within 40 dB of the loudest (plus a little around them). */
function trimSilence(x, sr) {
  const fl = Math.max(1, Math.round(sr * 0.02));
  const nf = Math.floor(x.length / fl);
  if (nf < 1) return Float32Array.from(x);
  const rms = new Float64Array(nf);
  let max = 0;
  for (let f = 0; f < nf; f++) {
    let s = 0;
    for (let i = f * fl; i < (f + 1) * fl; i++) s += x[i] * x[i];
    rms[f] = Math.sqrt(s / fl);
    if (rms[f] > max) max = rms[f];
  }
  if (max <= 0) return new Float32Array(0);
  const thr = max * 0.01;
  const keep = new Uint8Array(nf);
  for (let f = 0; f < nf; f++) if (rms[f] >= thr) for (let g = Math.max(0, f - 3); g <= Math.min(nf - 1, f + 3); g++) keep[g] = 1;
  let count = 0;
  for (let f = 0; f < nf; f++) if (keep[f]) count++;
  const out = new Float32Array(count * fl);
  let o = 0;
  for (let f = 0; f < nf; f++) if (keep[f]) { out.set(x.subarray(f * fl, (f + 1) * fl), o); o += fl; }
  return out;
}

function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : 0;
}

const f32ToB64 = (f) => Buffer.from(Float32Array.from(f).buffer).toString('base64');
const b64ToF32 = (s) => { const b = Buffer.from(s, 'base64'); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

// --- downloads ---------------------------------------------------------------------------------------------------------

const CONNECT_MS = 15000, STALL_MS = 30000;
const mirrorOf = (u) => u.startsWith(HF) ? 'https://hf-mirror.com/' + u.slice(HF.length) : null;

/** All the places a file can come from, in the order to try them. */
function sourcesFor(m, preferMirror) {
  const list = [m.url, ...(m.alt || [])];
  const hf = list.filter((u) => u.startsWith(HF));
  const mirrors = hf.map(mirrorOf);
  return preferMirror ? [...mirrors, ...list] : [...list, ...mirrors];
}

const verified = new Map();          // file -> 'size:mtime:sha' already checked in this process (hashing 580 MB takes seconds)

async function fileOk(file, m) {
  try {
    const st = await fs.promises.stat(file);
    if (st.size !== m.bytes) return false;
    const stamp = st.size + ':' + st.mtimeMs + ':' + m.sha256;
    if (verified.get(file) === stamp) return true;
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => fs.createReadStream(file).on('data', (d) => hash.update(d)).on('end', resolve).on('error', reject));
    const ok = hash.digest('hex') === m.sha256;
    if (ok) verified.set(file, stamp); else verified.delete(file);
    return ok;
  } catch (e) { return false; }
}

async function downloadOne(url, part, m, onBytes) {
  const ctl = new AbortController();
  let t = setTimeout(() => ctl.abort(), CONNECT_MS);
  let res;
  try { res = await fetch(url, { signal: ctl.signal, redirect: 'follow' }); } finally { clearTimeout(t); }
  if (!res.ok || !res.body) throw new Error('The download server answered ' + res.status);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let got = 0, failure = null;
  out.on('error', (e) => { failure = failure || e; ctl.abort(); });
  const reader = res.body.getReader();
  try {
    for (;;) {
      t = setTimeout(() => { failure = failure || new Error('ERR_CONNECTION the download stalled'); ctl.abort(); }, STALL_MS);
      let r;
      try { r = await reader.read(); } finally { clearTimeout(t); }
      if (failure) throw failure;
      if (r.done) break;
      hash.update(r.value);
      got += r.value.length;
      if (got > m.bytes) throw new Error('The downloaded voice model was damaged - please try again');
      if (!out.write(r.value)) await new Promise((ok) => { const done = () => { out.off('drain', done); out.off('error', done); ok(); }; out.once('drain', done); out.once('error', done); });
      onBytes(r.value.length);
    }
    await new Promise((ok, bad) => { out.once('error', bad); out.end(ok); });
  } catch (e) {
    out.destroy();
    throw failure || e;
  }
  if (got !== m.bytes || hash.digest('hex') !== m.sha256) throw new Error('The downloaded voice model was damaged - please try again');
}

const ensuring = new Map();          // modelsDir -> Promise (one download run per folder at a time)

/**
 * Makes sure every file in MODELS is in `dir` with the right size and SHA-256, downloading what is missing.
 * onProgress(fraction 0..1) is called as bytes arrive. Files are written as name.part and renamed when verified.
 * Options: { preferMirror } (hf-mirror.com first, e.g. in mainland China), { files } (a subset of the keys),
 * { table } (another table of the same shape instead of MODELS - for tests).
 * The folder may hold other files (e.g. the translator's); they are left alone.
 */
function ensureModels(dir, onProgress, opts) {
  const key = path.resolve(String(dir || ''));
  if (ensuring.has(key)) return ensuring.get(key);
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  const p = (async () => {
    if (!dir) throw new Error('No folder was given for the voice models');
    const table = opts && opts.table && typeof opts.table === 'object' ? opts.table : MODELS;
    const names = (opts && Array.isArray(opts.files) ? opts.files : Object.keys(table)).filter((n) => Object.hasOwn(table, n));
    for (const n of names) if (path.isAbsolute(n) || n.split(/[\\/]/).includes('..')) throw new Error('Bad model file name: ' + n);
    const preferMirror = Boolean(opts && opts.preferMirror);
    const missing = [];
    for (const name of names) if (!(await fileOk(path.join(key, name), table[name]))) missing.push(name);
    const total = missing.reduce((s, n) => s + table[n].bytes, 0);
    let done = 0, last = 0;
    const tick = (b) => { done += b; const now = Date.now(); if (now - last > 250) { last = now; report(total ? Math.min(1, done / total) : 1); } };
    for (const name of missing) {
      const m = table[name];
      const final = path.join(key, name);
      const part = final + '.part';
      await fs.promises.mkdir(path.dirname(final), { recursive: true });
      let lastErr = null, ok = false;
      const before = done;
      for (const url of sourcesFor(m, preferMirror)) {
        done = before;
        try {
          await downloadOne(url, part, m, tick);
          await fs.promises.rm(final, { force: true });
          await fs.promises.rename(part, final);
          const st = await fs.promises.stat(final);
          verified.set(final, st.size + ':' + st.mtimeMs + ':' + m.sha256);   // just hashed while downloading
          ok = true;
          break;
        } catch (e) {
          lastErr = e;
          await fs.promises.rm(part, { force: true }).catch(() => {});
        }
      }
      if (!ok) {
        const msg = String((lastErr && lastErr.message) || lastErr);
        if (/ENOSPC/i.test(msg)) throw new Error('There is not enough free disk space for the voice models');
        if (/damaged/i.test(msg)) throw lastErr;
        if (/answered 4\d\d/.test(msg)) throw new Error('The voice model is no longer at its download address (' + msg + ')');
        if (/ERR_|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|fetch failed|abort|stalled|answered/i.test(msg)) throw new Error('The voice models could not be downloaded - check the internet connection and try again');
        throw lastErr;
      }
    }
    report(1);
  })().finally(() => ensuring.delete(key));
  ensuring.set(key, p);
  return p;
}

// --- the engine --------------------------------------------------------------------------------------------------------

const now = () => Number(process.hrtime.bigint() / 1000000n);
const TAU = 0.3;                   // OpenVoice's default: how freely the converter may re-shape the source
const MAX_CHARS = 600;             // ~40 words and then some

/** A short dummy input for timing a converter session (the first runs also compile it for the device). */
function probeFeeds(ort, frames) {
  const spec = new Float32Array(N_BINS * frames);
  for (let i = 0; i < spec.length; i++) spec[i] = 0.01 + 0.5 * Math.abs(Math.sin(i * 0.37));
  const tone = (v) => new ort.Tensor('float32', new Float32Array(256).fill(v), [1, 256, 1]);
  return {
    audio: new ort.Tensor('float32', spec, [1, N_BINS, frames]),
    audio_length: new ort.Tensor('int64', BigInt64Array.from([BigInt(frames)]), [1]),
    src_tone: tone(0.05), dest_tone: tone(-0.05),
    tau: new ort.Tensor('float32', Float32Array.from([TAU]), [1])
  };
}

const PROBE_FRAMES = 256;           // ~3 s of audio
const FAST_MS = 350;                 // a converter that does ~3 s of audio this fast is taken without looking further
const PROBE_BUDGET_MS = 12000;       // stop trying more graphics adapters after this long

async function timeSession(ort, session) {
  await session.run(probeFeeds(ort, 16));                  // the first run compiles the graph for the device
  const t = process.hrtime.bigint();
  await session.run(probeFeeds(ort, PROBE_FRAMES));
  return Number(process.hrtime.bigint() - t) / 1e6;
}

let rememberedDevice = null;         // the adapter that won last time in this process

/**
 * DirectML's adapter order is the system's: on a hybrid laptop 0 is usually the integrated GPU (measured here: ~4x
 * slower than the CPU, plus ~7 s to compile), 1 the discrete card (~10x faster than the CPU), and the last one is
 * Microsoft's software renderer. onnxruntime-node cannot ask for "high performance" and blocks the JS thread while it
 * creates or runs a session, so adapters are timed one at a time, 1 first, and the first fast one is kept.
 * In 'auto' the CPU is used when no adapter is fast and the CPU is quicker.
 */
async function pickConverter(ort, file, want, cpuOpts, forcedDevice) {
  const cpu = async () => ({ session: await ort.InferenceSession.create(file, cpuOpts), provider: 'cpu' });
  if (want === 'cpu' || process.platform !== 'win32') return cpu();
  const dml = (id) => ({ executionProviders: [{ name: 'dml', deviceId: id }], enableMemPattern: false, executionMode: 'sequential', graphOptimizationLevel: 'all', logSeverityLevel: 3 });
  const order = Number.isInteger(forcedDevice) ? [forcedDevice] : rememberedDevice !== null ? [rememberedDevice, 1, 0, 2, 3] : [1, 0, 2, 3];
  const ids = [...new Set(order)];
  const started = Date.now();
  let best = null;
  for (const id of ids) {
    if (best && Date.now() - started > PROBE_BUDGET_MS) break;
    let session = null;
    try {
      session = await ort.InferenceSession.create(file, dml(id));
      const ms = await timeSession(ort, session);
      if (!best || ms < best.ms) { if (best) best.session.release().catch(() => {}); best = { session, provider: 'dml:' + id, id, ms }; } else session.release().catch(() => {});
      if (ms <= FAST_MS) break;
    } catch (e) {
      if (session) session.release().catch(() => {});
      if (Number.isInteger(forcedDevice)) break;
    }
  }
  if (want === 'auto' && (!best || best.ms > FAST_MS)) {
    const c = await cpu();
    const ms = await timeSession(ort, c.session);
    if (!best || ms < best.ms) { if (best) best.session.release().catch(() => {}); best = { ...c, ms }; } else c.session.release().catch(() => {});
  }
  if (!best) {
    if (want === 'dml') throw new Error('The graphics card could not run the voice converter');
    return cpu();
  }
  if (best.provider !== 'cpu') rememberedDevice = best.id;
  return { session: best.session, provider: best.provider, probeMs: Math.round(best.ms) };
}

function loadNative() {
  // onnxruntime-node first: its onnxruntime.dll is the newer one, and Windows keeps whichever loads first.
  let ort, sherpa;
  // (Measured: if sherpa-onnx-node loads first, onnxruntime-node then fails with "The operating system cannot run %1".)
  const why = (name, e) => new Error(e && e.code === 'MODULE_NOT_FOUND'
    ? 'The voice engine is not part of this build (' + name + ' is missing)'
    : 'The voice engine could not start (' + name + ': ' + String((e && e.message) || e).split('\n')[0] + ')');
  try { ort = require('onnxruntime-node'); } catch (e) { throw why('onnxruntime-node', e); }
  try { sherpa = require('sherpa-onnx-node'); } catch (e) { throw why('sherpa-onnx-node', e); }
  return { ort, sherpa };
}

/**
 * createEngine({ modelsDir, provider: 'cpu' | 'dml' | 'auto', threads, deviceId }) -> {
 *   speakerFromPcm(Float32Array, sampleRate) -> Float32Array(256),
 *   synth(text, lang, embedding|null) -> { pcm: Float32Array, sampleRate, voice, timing: { baseMs, convertMs } }
 *     (null embedding = the plain base voice at its own rate; converted speech is 22050 Hz),
 *   languages(), provider ('cpu' | 'dml:<adapter>'), dispose() }
 * Calls are queued and run one at a time.
 */
async function createEngine(opts) {
  const o = opts || {};
  const dir = path.resolve(String(o.modelsDir || ''));
  const want = o.provider === 'cpu' || o.provider === 'dml' ? o.provider : 'auto';
  const threads = Number.isInteger(o.threads) && o.threads > 0 ? o.threads : Math.max(2, Math.min(6, (require('os').availableParallelism?.() || 4) >> 1));
  const f = (n) => path.join(dir, n);
  for (const n of ['tone_color.onnx', 'tone_extract.onnx']) if (!fs.existsSync(f(n))) throw new Error('The voice models are not downloaded yet');
  const { ort, sherpa } = loadNative();

  // The converter (150 MB) - on the fastest graphics card DirectML offers, else the CPU. The extractor is tiny: CPU.
  // No spinning: idle ONNX Runtime threads would otherwise keep cores busy while Kokoro is speaking.
  const cpuOpts = { executionProviders: ['cpu'], intraOpNumThreads: threads, graphOptimizationLevel: 'all', logSeverityLevel: 3, extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } } };
  const { session: converter, provider, probeMs } = await pickConverter(ort, f('tone_color.onnx'), want, cpuOpts, o.deviceId);
  const extractor = await ort.InferenceSession.create(f('tone_extract.onnx'), cpuOpts);

  // The base voices, created on first use per engine type.
  const tts = {};
  function baseTts(kind) {
    if (tts[kind]) return tts[kind];
    const common = { numThreads: threads, debug: 0, provider: 'cpu' };
    if (kind === 'kokoro') {
      tts.kokoro = new sherpa.OfflineTts({
        model: { kokoro: { model: f('kokoro-v1_0.onnx'), voices: f('kokoro-v1_0-voices.bin'), tokens: f('kokoro-v1_0-tokens.txt'), dataDir: f('espeak-ng-data'), lexicon: f('kokoro-lexicon-us-en.txt') + ',' + f('kokoro-lexicon-zh.txt'), lang: '' }, ...common },
        maxNumSentences: 1
      });
    } else {
      tts.piper = new sherpa.OfflineTts({
        model: { vits: { model: f('piper-ru_RU-denis-medium.onnx'), tokens: f('piper-ru_RU-denis-tokens.txt'), dataDir: f('espeak-ng-data') }, ...common },
        maxNumSentences: 1
      });
    }
    return tts[kind];
  }

  async function seFromSpec(spec, frames) {
    const t = new ort.Tensor('float32', spec, [1, frames, N_BINS]);
    const r = await extractor.run({ input: t });
    return Float32Array.from(r.tone_embedding.data);
  }

  /** OpenVoice tone colour of 22050 Hz audio: mean over ~10 s chunks of speech (pauses dropped). */
  async function toneOf(y22) {
    const sp = trimSilence(y22, SR);
    const src = sp.length >= SR * 0.5 ? sp : y22;
    const CH = SR * 10;
    const n = Math.max(1, Math.round(src.length / CH));
    const acc = new Float32Array(256);
    let wsum = 0;
    for (let i = 0; i < n; i++) {
      const piece = src.subarray(Math.floor(i * src.length / n), Math.floor((i + 1) * src.length / n));
      if (piece.length < HOP * 8) continue;
      const { data, frames } = spectrogram(piece);
      const se = await seFromSpec(data, frames);
      for (let k = 0; k < 256; k++) acc[k] += se[k] * piece.length;
      wsum += piece.length;
    }
    if (!wsum) throw new Error('Too little speech to copy the voice');
    for (let k = 0; k < 256; k++) acc[k] /= wsum;
    return acc;
  }

  /** Base speech, off the main thread (generateAsync) so the process stays responsive. */
  async function generate(text, lang, voice) {
    const L = LANGS[lang];
    const k = baseTts(L.engine);
    const req = { text, sid: voice.sid, speed: 1 };
    // Kokoro reads non-English/Chinese text through espeak-ng; the language is chosen per call.
    if (L.engine === 'kokoro' && L.kokoroLang) req.generationConfig = new sherpa.GenerationConfig({ sid: voice.sid, speed: 1, extra: { lang: L.kokoroLang } });
    // generateAsync's promise never settles inside Electron's utility process ("TTS settlement failed"); the engine has a
    // process of its own, so generating on its main thread there blocks nothing the app needs.
    const useAsync = typeof k.generateAsync === 'function' && !process.versions.electron;
    const a = useAsync ? await k.generateAsync(req) : k.generate(req);
    return { pcm: Float32Array.from(a.samples), sampleRate: a.sampleRate };
  }

  const seCache = new Map();          // voice name -> its tone colour (from the table, or measured once)
  async function voiceSe(lang, voice) {
    if (seCache.has(voice.name)) return seCache.get(voice.name);
    let se = voice.se ? b64ToF32(voice.se) : null;
    if (!se || se.length !== 256) {
      const a = await generate(CALIBRATION[lang], lang, voice);
      se = await toneOf(resample(a.pcm, a.sampleRate, SR));
    }
    seCache.set(voice.name, se);
    return se;
  }

  async function pickVoice(lang, emb) {
    const vs = LANGS[lang].voices;
    if (!emb || vs.length === 1) return vs[0];
    let best = vs[0], bestSim = -2;
    for (const v of vs) { const s = cosine(await voiceSe(lang, v), emb); if (s > bestSim) { bestSim = s; best = v; } }
    return best;
  }

  let disposed = false;
  let queue = Promise.resolve();      // one job at a time: the native sessions are not shared between calls
  const serial = (fn) => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };

  async function speakerFromPcm(pcm, sampleRate) {
    if (disposed) throw new Error('The voice engine was closed');
    if (!pcm || !(pcm.length > 0) || !(sampleRate > 0)) throw new Error('No audio');
    return toneOf(resample(pcm, sampleRate, SR));
  }

  async function synth(text, lang, emb, opt) {
    if (disposed) throw new Error('The voice engine was closed');
    const L = Object.hasOwn(LANGS, lang) ? LANGS[lang] : null;
    if (!L || !L.supported) throw new Error('No voice for this language: ' + lang);
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
    if (!clean) return { pcm: new Float32Array(0), sampleRate: SR };
    // A profile that is not 256 finite numbers (another format, damaged file) gives the plain voice, not noise.
    const target = emb && emb.length === 256 && Array.prototype.every.call(emb, Number.isFinite) ? Float32Array.from(emb) : null;
    const voice = (opt && opt.voice && L.voices.find((v) => v.name === opt.voice)) || await pickVoice(lang, target);
    const t0 = now();
    const base = await generate(clean, lang, voice);
    const t1 = now();
    base.voice = voice.name;
    base.timing = { baseMs: t1 - t0, convertMs: 0 };
    if (!target || !base.pcm.length) return base;
    const y = resample(base.pcm, base.sampleRate, SR);
    const { data, frames } = spectrogram(y);
    if (frames < 4) return base;
    const src = await voiceSe(lang, voice);
    const r = await converter.run({
      audio: new ort.Tensor('float32', transpose(data, frames, N_BINS), [1, N_BINS, frames]),
      audio_length: new ort.Tensor('int64', BigInt64Array.from([BigInt(frames)]), [1]),
      src_tone: new ort.Tensor('float32', src, [1, 256, 1]),
      dest_tone: new ort.Tensor('float32', target, [1, 256, 1]),
      tau: new ort.Tensor('float32', Float32Array.from([opt && typeof opt.tau === 'number' ? opt.tau : TAU]), [1])
    });
    const out = Float32Array.from(r.converted_audio.data);
    let peak = 0;
    for (let i = 0; i < out.length; i++) { const v = Math.abs(out[i]); if (v > peak) peak = v; }
    if (peak > 0.98) { const g = 0.98 / peak; for (let i = 0; i < out.length; i++) out[i] *= g; }
    return { pcm: out, sampleRate: SR, voice: voice.name, timing: { baseMs: t1 - t0, convertMs: now() - t1 } };
  }

  return {
    provider,                        // 'cpu' or 'dml:<adapter>'
    probeMs,                         // how long the chosen converter took for ~3 s of audio when it was picked
    languages() { return Object.keys(LANGS).filter((l) => LANGS[l].supported); },
    speakerFromPcm: (pcm, sampleRate) => serial(() => speakerFromPcm(pcm, sampleRate)),
    synth: (text, lang, emb, opt) => serial(() => synth(text, lang, emb, opt)),

    /** Unconverted base speech (for measuring); not used by the app. */
    _base: (text, lang, voiceName) => serial(() => generate(text, lang, LANGS[lang].voices.find((v) => v.name === voiceName) || LANGS[lang].voices[0])),
    _toneOf: (y22) => serial(() => toneOf(y22)),

    async dispose() {
      disposed = true;
      await queue.catch(() => {});
      for (const s of [converter, extractor]) { try { await s.release(); } catch (e) { /* already gone */ } }
      for (const k of Object.keys(tts)) delete tts[k];      // sherpa frees its handle when garbage-collected
    }
  };
}

// Text used to measure a base voice's own tone colour when the table has none.
const CALIBRATION = {
  en: 'The quick brown fox jumps over the lazy dog. I will call you back in the evening, after the meeting is over.',
  es: 'El veloz murciélago hindú comía feliz cardillo y kiwi. Te llamo esta tarde, cuando termine la reunión.',
  hi: 'मैं शाम को आपको फिर से फ़ोन करूँगा, जब बैठक ख़त्म हो जाएगी। आज मौसम बहुत अच्छा है।',
  zh: '我今天晚上开完会以后再给你打电话。今天的天气非常好，我们出去走走吧。',
  ru: 'Я перезвоню вам вечером, когда закончится совещание. Сегодня очень хорошая погода.'
};

module.exports = {
  MODELS, LANGS, ensureModels, createEngine,
  _dsp: { makeFft, hannWindow, spectrogram, transpose, resample, trimSilence, cosine, f32ToB64, b64ToF32, SR, N_FFT, HOP, N_BINS },
  _test: { sourcesFor, mirrorOf, fileOk, CALIBRATION }
};
