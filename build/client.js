"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Promise = require("bluebird");
const Greenlock = require("greenlock");
const LEStore = require("le-store-certbot");
const _ = require("lodash");
const mkdirp = require("mkdirp-promise");
const mzfs = require("mz/fs");
const typed_error_1 = require("typed-error");
const dns_update_client_1 = require("./dns-update-client");
var CertificateClientErrorCodes;
(function (CertificateClientErrorCodes) {
    CertificateClientErrorCodes[CertificateClientErrorCodes["INVALID_TOKEN"] = 0] = "INVALID_TOKEN";
    CertificateClientErrorCodes[CertificateClientErrorCodes["MISSING_CONFIG"] = 1] = "MISSING_CONFIG";
    CertificateClientErrorCodes[CertificateClientErrorCodes["EXISTING_DOMAIN_CHALLENGE"] = 2] = "EXISTING_DOMAIN_CHALLENGE";
    CertificateClientErrorCodes[CertificateClientErrorCodes["MISSING_DOMAIN_CHALLENGE"] = 3] = "MISSING_DOMAIN_CHALLENGE";
    CertificateClientErrorCodes[CertificateClientErrorCodes["EXISTING_CERTIFICATE"] = 4] = "EXISTING_CERTIFICATE";
    CertificateClientErrorCodes[CertificateClientErrorCodes["INVALID_RESPONSE"] = 5] = "INVALID_RESPONSE";
    CertificateClientErrorCodes[CertificateClientErrorCodes["SERVICE_ERROR"] = 6] = "SERVICE_ERROR";
})(CertificateClientErrorCodes = exports.CertificateClientErrorCodes || (exports.CertificateClientErrorCodes = {}));
class CertificateClientError extends typed_error_1.TypedError {
    constructor(code, message) {
        super();
        this.code = code;
        this.message = message;
    }
}
exports.CertificateClientError = CertificateClientError;
class BalenaCertificateClient {
    constructor(constructOpts) {
        this.challengeMap = new Map();
        if (!constructOpts.dnsUpdateHost ||
            !constructOpts.dnsUpdatePort ||
            !constructOpts.authToken ||
            !constructOpts.configRoot) {
            throw new CertificateClientError(1, 'A DNS service host, port, authentication token and config root must be specified');
        }
        this.dnsClient = new dns_update_client_1.DnsUpdateClient({
            host: constructOpts.dnsUpdateHost,
            port: constructOpts.dnsUpdatePort,
            authToken: constructOpts.authToken,
        });
        this.configDirectory = constructOpts.configRoot;
        this.greenlock = Greenlock.create({
            version: 'draft-12',
            server: 'https://acme-v02.api.letsencrypt.org/directory',
            store: LEStore.create({
                configDir: this.configDirectory,
            }),
            challenges: {
                'dns-01': this.dnsChallenge(),
            },
            renewWithin: 14 * 24 * 60 * 60 * 1000,
            renewBy: 10 * 24 * 60 * 60 * 1000,
        });
    }
    dnsChallenge(options) {
        return {
            getOptions: () => {
                return options || {};
            },
            set: (_args, domain, _challenge, keyAuthorization, callback) => {
                const txtDomain = `_acme-challenge.${domain}`;
                var keyAuthDigest = require('crypto')
                    .createHash('sha256')
                    .update(keyAuthorization || '')
                    .digest('base64')
                    .replace(/\+/g, '-')
                    .replace(/\//g, '_')
                    .replace(/=+$/g, '');
                Promise.try(() => {
                    if (this.challengeMap.has(txtDomain)) {
                        throw new CertificateClientError(4, 'A challenge for a certificate already exists');
                    }
                    this.challengeMap.set(txtDomain, keyAuthDigest);
                    return this.dnsClient.updateTxtRecord(txtDomain, keyAuthDigest);
                }).asCallback(callback);
            },
            get: (_defaults, _domain, _challenge, callback) => {
                callback(null);
            },
            remove: (_args, domain, _challenge, callback) => {
                const txtDomain = `_acme-challenge.${domain}`;
                Promise.try(() => {
                    const keyAuthDigest = this.challengeMap.get(txtDomain);
                    if (!keyAuthDigest) {
                        throw new CertificateClientError(3, 'The challenge text for a domain is missing from the challenge map');
                    }
                    return this.dnsClient.removeTxtRecord(txtDomain, keyAuthDigest);
                }).asCallback(callback);
            },
        };
    }
    requestCertificate(certRequest) {
        const greenlockInst = this.greenlock;
        const outDir = certRequest.outputLocation;
        const domain = certRequest.domain;
        const subdomains = certRequest.subdomains;
        const requestDomains = !subdomains
            ? [domain]
            : _.reduce(subdomains, (result, value) => {
                result.push(`${value}.${domain}`);
                return result;
            }, ['']).slice(1);
        let certificates = null;
        return greenlockInst
            .check({ domains: requestDomains })
            .then(function (results) {
            if (results) {
                if (!certRequest.renewing) {
                    throw new CertificateClientError(4, 'A certificate already exists for the requested domain');
                }
            }
            return greenlockInst
                .register({
                domains: requestDomains,
                email: certRequest.email,
                agreeTos: true,
                rsaKeySize: 2048,
                challengeType: 'dns-01',
            })
                .then((results) => {
                certificates = {
                    ca: results.chain,
                    privateKey: results.privkey,
                    certificate: results.cert,
                };
                let resultPromise = Promise.resolve();
                if (outDir) {
                    const outFiles = [
                        { file: `${outDir}/ca.pem`, data: certificates.ca },
                        {
                            file: `${outDir}/private-key.pem`,
                            data: certificates.privateKey,
                        },
                        {
                            file: `${outDir}/certificate.pem`,
                            data: certificates.certificate,
                        },
                    ];
                    resultPromise = mkdirp(outDir).then(() => {
                        return Promise.map(outFiles, entry => {
                            return mzfs.writeFile(entry.file, entry.data);
                        }).return();
                    });
                }
                return resultPromise;
            });
        })
            .then(() => {
            return Promise.map(requestDomains, newDomain => {
                return this.dnsClient.updateARecord(newDomain, certRequest.ip);
            });
        })
            .return(certificates)
            .catch((error) => {
            if (_.includes(error.message, 'A valid bearer token must be included in the request')) {
                throw new CertificateClientError(0, 'The passed bearer token was invalid');
            }
            throw error;
        });
    }
}
exports.BalenaCertificateClient = BalenaCertificateClient;
//# sourceMappingURL=client.js.map