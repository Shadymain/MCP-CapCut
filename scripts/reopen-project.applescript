-- EXPERIMENTAL: reopen a CapCut project by name after live sync relaunches CapCut.
-- Untested against CapCut's real interface: CapCut may not expose its project grid to
-- macOS accessibility. If it prints "not found", ask Claude Code to inspect CapCut's UI
-- (System Events "entire contents") and adapt this script.
-- Enable with: CAPCUT_REOPEN_SCRIPT=/full/path/to/scripts/reopen-project.applescript
-- Needs: System Settings > Privacy & Security > Accessibility > allow Claude.
on run argv
	set projectName to item 1 of argv
	tell application "CapCut" to activate
	delay 4 -- give the home screen time to load
	tell application "System Events"
		tell process "CapCut"
			repeat with el in (entire contents of front window)
				try
					set label to ""
					try
						set label to (name of el) as text
					end try
					if label is "" then
						try
							set label to (description of el) as text
						end try
					end if
					if label is projectName then
						try
							perform action "AXPress" of el
						on error
							click el
						end try
						return "opened"
					end if
				end try
			end repeat
		end tell
	end tell
	return "not found"
end run
