# Suno CoverBot Setup

The Windows setup tool for the Suno CoverBot Chrome extension. It downloads the extension package, checks the signed
release metadata and the package hash before writing any file, installs the extension in Chrome's developer mode, and
registers a quiet scheduled updater. The updater keeps the extension **and itself** on the release the owner approved;
it never restarts the browser and never answers a browser prompt on the user's behalf.

## Build

Node.js 22 or newer on Windows:

```
set SCB_RELEASE_PUBLIC_KEY=<release public key, PEM>
set SCB_ACTION_PUBLIC_KEY=<action public key, PEM>
node scripts/setup-tool/build.mjs
```

The output is `scratch/setup-tool-build/SunoCoverBotSetup.exe`. Only public keys are used; no secret is needed to build.

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

- Committers and reviewers: [yackov43](https://github.com/yackov43)
- Approvers: [yackov43](https://github.com/yackov43)

Every release binary is built by the GitHub Actions workflow in this repository from the tagged source and signed only
after an approver releases the signing request.

## Privacy

This program connects only to the Suno CoverBot server, to download the extension and its release metadata and to
report update status (installed versions, update state and errors). It does not read or transmit Suno credentials,
cookies or browsing data, and it transfers no other information to other networked systems unless the user asks it to.
