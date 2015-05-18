# umbra
The missing CLI for managing Englishtown Umbraco (umbraco.englishtown.com) contents from local files.

It works in a similar fashion with Git, contents live in Umbraco are tracked like remote objects while we check them out locally 
as a flatten list of files, with each file representing a tree node from a specified **root node** that you're interested in. Each of the local
file name matches the **CMS key** of the remote node in Umbraco.  

This results in local CMS files that can be tracked in version control system, making local modifications are much easier, as well as having
the goodness to preview/debug contents locally before actually publish them in Umbraco.   

## Installation
```bash
npm i -g umbra
```

## authorization
The CLI connect to Umbraco using the same authentication method as with the web interface, first time you issue any command 
will give you the prompt for entering the credentials and will store that as a simple user preference file and use that for 
authentication until you explicitly ask for a change.

```
prompt: username: garry.yao
prompt: password: *****
```

## clone from Umbraco 
This command like 'git clone' will fetch and pull all Umbraco tree nodes from the specific 'path', to the local directory 'dir'.

```bash
umbra clone School/HeaderFooter headerfooter 
```

## pull new files from Umbraco
When issued in a repository directory, this command will pull all the new files added from Umbraco.  

```bash
cd headerfooter
umbra pull
```

## push local file changes 
When issued from a repository directory, this command will push content of specific/all local files to the corresponding content nodes in Umbraco. 

```bash
cd headerfooter
umbra push **/*.html
```
