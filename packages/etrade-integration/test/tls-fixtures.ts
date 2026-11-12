import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TlsChain {
  rootPem: string;
  intermediatePem: string;
  leafPem: string;
  leafKey: string;
}

/**
 * A throwaway root -> intermediate -> leaf chain for 127.0.0.1, made with openssl at test time
 * so nothing shaped like a key is committed. The leaf is served WITHOUT its intermediate, the
 * way etrade.gov.et serves its certificate. Returns null when openssl is not installed (the
 * TLS tests then skip, and say so).
 */
export function makeChainWithoutIntermediate(): TlsChain | null {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
  } catch {
    return null;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "etrade-tls-"));
  const run = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  try {
    fs.writeFileSync(path.join(dir, "ca.ext"), "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n");
    fs.writeFileSync(
      path.join(dir, "leaf.ext"),
      "basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n",
    );
    run("req", "-x509", ...ec, "-keyout", "root.key", "-out", "root.pem", "-days", "2", "-subj", "/CN=Test Root",
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
    run("req", ...ec, "-keyout", "int.key", "-out", "int.csr", "-subj", "/CN=Test Intermediate");
    run("x509", "-req", "-in", "int.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-out", "int.pem",
      "-days", "2", "-extfile", "ca.ext");
    run("req", ...ec, "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=127.0.0.1");
    run("x509", "-req", "-in", "leaf.csr", "-CA", "int.pem", "-CAkey", "int.key", "-CAcreateserial", "-out", "leaf.pem",
      "-days", "2", "-extfile", "leaf.ext");
    const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");
    return { rootPem: read("root.pem"), intermediatePem: read("int.pem"), leafPem: read("leaf.pem"), leafKey: read("leaf.key") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
