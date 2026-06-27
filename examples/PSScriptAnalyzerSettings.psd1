@{
    # PSScriptAnalyzer config for examples/**/*.ps1 (the CLI mirrors).
    # Self-documenting like the repo's .markdownlint.yaml: each exclusion says WHY.
    Severity     = @('Error', 'Warning')

    ExcludeRules = @(
        # PSAvoidUsingWriteHost: these are INTERACTIVE example scripts whose whole
        # job is to narrate progress to the user's console. Write-Host is the
        # correct tool for that (Write-Output would pollute the pipeline / return
        # value). The rule targets reusable modules/functions, not scripts-as-demos.
        'PSAvoidUsingWriteHost'
    )

    # Everything else stays on (Error + Warning), including:
    #   PSUseBOMForUnicodeEncodedFile  - we keep the .ps1 files ASCII-clean to match
    #                                    their .sh/.ts siblings, so this never fires;
    #                                    if non-ASCII sneaks in without a BOM, catch it.
    #   PSAvoidUsingEmptyCatchBlock    - real smell; cleanup catches log via Write-Verbose.
}
