//! Test de l'application sûre des configurations nginx contre `testenv` (localhost:2222).
//! `cargo run -p zenytt-core --example nginx_smoke`

use zenytt_core::{nginx, Auth, ConnectParams, Connection, Error};

async fn connect(user: &str, pw: &str) -> Result<Connection, Box<dyn std::error::Error>> {
    let mut params = ConnectParams {
        host: "127.0.0.1".into(),
        port: 2222,
        username: user.into(),
        auth: Auth::Password { password: pw.into() },
        known_fingerprint: None,
    };
    match Connection::connect(params.clone()).await {
        Err(Error::UnknownHostKey(fp)) => {
            params.known_fingerprint = Some(fp);
            Ok(Connection::connect(params).await?)
        }
        other => Ok(other?),
    }
}

async fn http(conn: &Connection, host: &str) -> String {
    conn.run(&format!("curl -s -o /dev/null -w '%{{http_code}}' -H 'Host: {host}' http://127.0.0.1/ || true")).await.unwrap_or_default()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Utilisateur non root : tout passe par sudo, comme sur un VPS bien configuré.
    let conn = connect("deploy", "deploy").await?;
    let sudo = Some("deploy");
    let root = connect("root", "zenytt").await?;
    root.run("command -v curl >/dev/null || (apt-get install -y curl >/dev/null 2>&1)").await?;

    let st = nginx::discover(&conn, sudo).await?;
    assert!(st.installed && st.running, "nginx absent : {st:?}");
    let demo = st.files.iter().find(|f| f.path.ends_with("demo.example.com")).expect("site demo");
    assert_eq!(demo.servers[1].upstream_ports, vec![8081]);
    let cert = st.certificates.first().expect("certificat lu via sudo");
    let days = (cert.not_after - chrono_now()) / 86400;
    assert!((40..=46).contains(&days), "expiration : {days} j");
    println!("✓ découverte : {} site(s), certificat démo expire dans {days} j", st.files.len());

    let avail = "/etc/nginx/sites-available/zenytt-test.example.com";
    let link = "/etc/nginx/sites-enabled/zenytt-test.example.com";
    let _ = nginx::delete_site_for(&conn, sudo, nginx::Engine::Nginx, avail, link).await;

    // 1. Nouveau site valide → appliqué, servi par nginx.
    let good = nginx::proxy_vhost("zenytt-test.example.com", 8081);
    let r = nginx::write_config_for(&conn, sudo, nginx::Engine::Nginx, avail, &good, Some(link), "").await?;
    assert!(r.ok, "{r:?}");
    assert_eq!(http(&root, "zenytt-test.example.com").await, "200");
    println!("✓ site ajouté, sauvegarde {} , HTTP 200 via nginx", r.backup.unwrap());

    // 2. Configuration cassée → refusée ET restaurée, nginx continue de servir.
    let r = nginx::write_config_for(
        &conn,
        sudo,
        nginx::Engine::Nginx,
        avail,
        "server { listen 80; server_name x; location / { proxy_pass http://127.0.0.1:1 }",
        Some(link),
        "",
    )
    .await?;
    assert!(!r.ok, "une config invalide a été acceptée");
    assert!(r.log.contains("emerg"), "log : {}", r.log);
    assert_eq!(root.run(&format!("cat {avail}")).await?, good, "fichier non restauré");
    assert_eq!(http(&root, "zenytt-test.example.com").await, "200");
    assert_eq!(http(&root, "demo.example.com").await, "301");
    println!("✓ config invalide refusée, fichier restauré, les sites restent en ligne");

    // 3. Nouveau fichier invalide → supprimé (n'existait pas avant), lien retiré.
    let bad_new = "/etc/nginx/sites-available/zenytt-bad.example.com";
    let bad_link = "/etc/nginx/sites-enabled/zenytt-bad.example.com";
    let r = nginx::write_config_for(&conn, sudo, nginx::Engine::Nginx, bad_new, "nonsense;", Some(bad_link), "").await?;
    assert!(!r.ok);
    assert_eq!(root.run(&format!("ls {bad_new} {bad_link} 2>/dev/null | wc -l")).await?.trim(), "0");
    println!("✓ nouveau fichier invalide entièrement retiré");

    // 4. Désactiver / réactiver / supprimer.
    assert!(nginx::set_enabled_for(&conn, sudo, nginx::Engine::Nginx, avail, link, false).await?.ok);
    assert_eq!(nginx::discover(&conn, sudo).await?.disabled.iter().filter(|f| f.path == avail).count(), 1);
    assert!(nginx::set_enabled_for(&conn, sudo, nginx::Engine::Nginx, avail, link, true).await?.ok);
    assert!(nginx::delete_site_for(&conn, sudo, nginx::Engine::Nginx, avail, link).await?.ok);
    assert_eq!(root.run(&format!("ls {avail} 2>/dev/null | wc -l")).await?.trim(), "0");
    println!("✓ désactivation, réactivation et suppression");

    // 5. Chemin hors de /etc/nginx refusé avant même d'appeler le serveur.
    assert!(nginx::write_config_for(&conn, sudo, nginx::Engine::Nginx, "/etc/passwd", "x", None, "").await.is_err());
    println!("✓ écriture hors de /etc/nginx refusée");

    let ports = nginx::used_ports(&conn).await?;
    assert!(ports.contains(&22) && ports.contains(&80), "{ports:?}");
    println!("✓ ports en écoute : {ports:?}");
    Ok(())
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
}
