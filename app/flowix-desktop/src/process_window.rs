#[cfg_attr(not(windows), allow(dead_code))]
use std::process::Command as StdCommand;
use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn hide_command_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
    cmd
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn hide_std_command_window(cmd: &mut StdCommand) -> &mut StdCommand {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
    cmd
}
