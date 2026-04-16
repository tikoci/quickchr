
# Lab Journal for "Scripting Patterns"

In order to build good RouterOS "scripting SKILL.md(s)", some commands do have odd behavior.  GH tikoci/quickchr runs into more than most.  This lab captures CLI/scripting patterns used for device-mode, license, packages, disk, users, ssh, etc. - all of which we have code here to support.  Like other RouterOS SKILL.md some may vary by version.

## Structure

JOURNAL.md => log of work, findings, work completed, organized chronically -> potentially ~updated~ historically with note on newer finding that refutes a prior statement, but generally an agent's version of the researcher's moleskin.
examples/*.rsc => source scripts to use as basis -> improve/refine as needed, more may be added overtime
REPORT.md => stores current results, always updated, prior content noted via `git` reference under "## Updates"

## Status => PLACEHOLDER FOR FUTURE WORK WITH MORE example/*.rsc TO USE

## Work Log

### 2026-04-16

- "Placeholder" with basic structure
- Add .rsc to show looping (:foreach), timing operations (:time), using \t columns (:put), /tool/fetch to call REST API via localhost on router (work via SSH, human tested via CLI), :local do= function using device-mode, :onerror as "exception blocks", and calls via REST to localhost using /tool/fetch to mimic Bun/curl externally as "third source of truth" on device-mode
