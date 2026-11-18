# @ehealth-co-id/typia-binary

A prebuilt [ttsc](https://ttsc.dev) plugin cache for [typia](https://typia.io).

## Why

1. IMHO, requiring you to build on your end defeats the point of software packages in general.
2. It is a hassle to setup cache for every single project even if you can share cache.
3. It takes too long to build on a constrained build agent.

## Use

Before installing the package, make sure to:

1. Use the EXACT matching versions of `ttsc`, `typia`, and `typescript`.
2. Use default GO flags when running ttsc. Don't set any flag like `CGO_ENABLED`, etc.

| package version | ttsc   | typescript | typia  |
| --------------- | ------ | ---------- | ------ |
| 15.0.1          | 0.30.4 | 7.0.2      | 15.0.1 |

Install the package: `npm install @ehealth-co-id/typia-binary` then allow the postinstall to run.
