fn main() {
    if let Err(error) = aneditor_lib::mcp_serve() {
        eprintln!("6byte-mcp: {error}");
        std::process::exit(1);
    }
}
