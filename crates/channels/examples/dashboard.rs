use anyhow::Result;
use luopan_channels::load_channel_dashboard;
use luopan_runtime::RuntimePaths;

fn main() -> Result<()> {
    let paths = RuntimePaths::from_env()?;
    println!(
        "{}",
        serde_json::to_string_pretty(&load_channel_dashboard(&paths)?)?
    );
    Ok(())
}
