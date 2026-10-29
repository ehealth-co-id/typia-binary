# @slainless/typia-binary

A prebuilt [ttsc](https://ttsc.dev) plugin cache for [typia](https://typia.io).

## Why

Because I want our build agent to just skip the tooling build ceremony and just straight to building our product instead. Also, I don't like setting up cache across many build configurations.

## Use

Before installing the package, make sure to:
1. Use the EXACT matching versions of `ttsc`, `typia`, and `typescript`. 
2. Use default GO flags when running ttsc. Don't set any flag like `CGO_ENABLED`, etc. 

Install the package: `npm install @slainless/typia-binary` then allow the postinstall to run.