# umbra
CLI for publish Umbraco CMS contents from local files of the [camp-ui](https://github.com/garryyao/camp-ui) repository.

## Install

For now this is not published as NPM for confidential concerns, consume from source is easy:

```bash
git clone [this repository]
cd umbra
npm link
cd [camp-ui]
npm link umbra
```
## publish local files
This command will publish all files in the **cms** directory as CMS contents.

```bash
cd camp-ui
umbra pub
```
