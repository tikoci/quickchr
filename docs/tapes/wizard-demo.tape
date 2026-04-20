Output docs/images/wizard-demo.gif

Set Shell "bash"
Set Width 950
Set Height 750
Set FontSize 14
Set Theme "Catppuccin Mocha"
Set PlaybackSpeed 1.0
Set TypingSpeed 80ms
Set Framerate 15

Hide
Type "export QUICKCHR_DATA_DIR=$(mktemp -d)"
Enter
Sleep 200ms
Show

Type "quickchr setup"
Sleep 400ms
Enter
Sleep 1400ms

# Step 1: Version source — accept default (By channel)
Enter
Sleep 700ms

# Step 2: Channel — accept default (long-term)
Enter
Sleep 700ms

# Step 3: Architecture — accept default (arm64 host native)
Enter
Sleep 600ms

# Step 4: Instance name — Enter for auto-generated
Enter
Sleep 600ms

# Step 5: CPU cores — accept default (1)
Enter
Sleep 600ms

# Step 6: Memory — accept default (256 MB)
Enter
Sleep 600ms

# Step 7: Boot disk format — accept default (qcow2)
Enter
Sleep 600ms

# Step 8: Resize boot disk? — accept default (No)
Enter
Sleep 600ms

# Step 9: Extra blank disks? — accept default (No)
Enter
Sleep 600ms

# Step 10: Add a real network?
# Default is Yes on macOS with socket_vmnet installed; navigate to No to keep demo simple
Left
Sleep 300ms
Enter
Sleep 3500ms

# Step 11: Configure router after boot? — accept default (Yes) to show provisioning flow
Enter
Sleep 600ms

# Step 11a: Extra packages — accept default (No extra packages)
Enter
Sleep 600ms

# Step 11b: Configure device-mode? — accept default (No)
Enter
Sleep 600ms

# Step 11c: CHR login setup — accept default (quickchr managed)
Enter
Sleep 600ms

# Step 11d: Apply trial license? — accept default (No)
Enter
Sleep 600ms

# Step 12: Run mode — accept default (Background)
Enter
Sleep 800ms

# Step 13: Final confirm "Start CHR?" — navigate to No (don't actually boot)
Left
Sleep 400ms
Enter
Sleep 1200ms
