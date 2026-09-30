# Platform support

What is actually verified on which operating system, and what is not.

This file exists because [#1602](https://github.com/NovaLux12/spotify-mcp-server/issues/1602) and [#1632](https://github.com/NovaLux12/spotify-mcp-server/issues/1632) both found the same gap from different directions: the README shipped Windows install instructions while every workflow in this repository ran on `ubuntu-latest` and nothing said so. A marketing claim the test suite does not back is worse than no claim, because a reader trusts it.

## The short version

| Platform | Install & run | Covered by CI | Notes |
|---|---|---|---|
| **Linux** (x64, arm64) | supported | **yes** — full suite, Node 22 and 24 | The tested platform. |
| **macOS** | supported | no | Behaves like Linux; POSIX paths and modes are native. |
| **Windows** | supported for install and everyday use | **no** | See the gaps below. |

The server is a plain Node ESM process with three runtime dependencies and no native modules, so it installs and starts on all three. What differs is what CI can prove.

## Why Windows is not in the matrix yet

Not an oversight, and not a shrug at the criterion — a measured cost.

**The suite is POSIX-shaped, and not shallowly.** 22 test files assert a file mode by reading it back:

```
$ grep -rln "mode & 0o777" tests/*.test.ts | wc -l
22
```

for example `tests/auth-hardening.test.ts:113`:

```ts
assert.equal(st.mode & 0o777, 0o600, 'tokens file must be owner-only');
```

On Windows `chmod` is close to a no-op and the mode bits are not POSIX, so every one of those assertions fails regardless of the code under test. Turning them into `process.platform` guards is a real porting job across two dozen files, and each guard is a place a future contributor can forget to add one.

**Five production branches would go unexercised either way.** All are `win32` guards around POSIX-only behaviour, chiefly `chmod` on the token file:

| Site | Guard |
|---|---|
| `src/auth.ts:663` | `if (process.platform !== 'win32')` |
| `src/auth.ts:695` | `if (process.platform !== 'win32') await chmod(tokenFile, 0o600)` |
| `src/accounts.ts:227` | `if (process.platform !== 'win32')` |
| `src/accounts.ts:233` | `if (process.platform !== 'win32')` |
| `src/http.ts:266` | `if (process.platform !== 'win32')` |

`src/auth.ts:695` is the one that matters most. On POSIX the server `chmod`s the token file to `0o600`; on Windows the guard skips it. That asymmetry is correct as written and completely untested — and it is exactly the shape of code where a later refactor that hoists the `chmod` out of the guard passes CI on Linux and silently stops protecting tokens on Windows.

## What this means for a Windows user

Honest inventory, not reassurance:

- **Install, authenticate, and the overwhelming majority of tools work.** `npm install`, `npx @novalux12/spotify-mcp@latest auth`, and the `doctor` check are the supported path and are documented in the README.
- **The five `win32` branches above are unexercised by CI.** They are written to be correct on Windows, but nothing in this repository proves it on a run you can inspect.
- **Token file permissions are not enforced on Windows**, by design of the `win32` guard. On NTFS the file inherits the profile directory's ACL, which is user-scoped; it is not the POSIX `0o600` guarantee.
- **A Windows-specific regression would not be caught before release.** That is the real cost of this row in the table.

## What would close it

In order, cheapest first:

1. **Guard the 22 mode assertions** behind `process.platform !== 'win32'`, the way `src/auth.ts` already guards its own `chmod`. This is the blocking work — until it is done, a Windows CI leg is a leg that fails for reasons unrelated to the code.
2. **Add `windows-latest` to the matrix** in `.github/workflows/ci.yml` alongside the existing `[22.x, 24.x]` axis. The Node axis is already there and proven, so the shape is a two-line change.
3. **Audit the POSIX-only helpers** in the same pass: `scripts/measure-startup.mjs` reads `/proc/<pid>/status` and returns `null` off Linux (already guarded), and `src/logout.ts` shells out to `gio trash` with a documented refusal where the platform cannot.

Step 1 is the whole of the cost. Steps 2 and 3 are small once it is done.

## The escape hatch, used

Epic #574 asked for cross-platform CI "or a documented reason there is none", and #575 the same for the smoke subset. This file is the documented reason, with the measurement behind it. If the criteria are ever re-read as requiring the matrix rather than the record, step 1 above is where that work starts.
