//! Machines virtuelles de bout en bout sur le serveur libvirt du `testenv` (127.0.0.1:2224) :
//! accès direct (groupe libvirt), inventaire, démarrage, écran VNC, arrêt forcé, puis un utilisateur
//! sans droits.
//!   docker compose -f testenv/docker-compose.yml up -d --build libvirt
//!   cargo run -p zenytt-core --example vm_smoke

use std::time::Duration;

use zenytt_core::vm::{self, Access, Graphics, VmAction, VmState};
use zenytt_core::{Auth, ConnectParams, Connection, Error};

async fn connect(user: &str, pw: &str) -> Result<Connection, Box<dyn std::error::Error>> {
    let params = |fp: Option<String>| ConnectParams {
        host: "127.0.0.1".into(),
        port: 2224,
        username: user.into(),
        auth: Auth::Password { password: pw.into() },
        known_fingerprint: fp,
    };
    let fp = match Connection::connect(params(None)).await {
        Err(Error::UnknownHostKey(fp)) => fp,
        other => return Err(format!("empreinte attendue, obtenu {:?}", other.err()).into()),
    };
    Ok(Connection::connect(params(Some(fp))).await?)
}

fn check(ok: bool, what: &str) -> Result<(), Box<dyn std::error::Error>> {
    if ok {
        println!("OK {what}");
        Ok(())
    } else {
        Err(format!("ÉCHEC : {what}").into())
    }
}

/// Attend un état (30 s au plus) : le démarrage en émulation n'est pas instantané.
async fn wait_state(c: &Connection, uuid: &str, want: VmState) -> Result<bool, Box<dyn std::error::Error>> {
    for _ in 0..30 {
        if vm::list(c, Access::Direct, None).await?.iter().any(|v| v.uuid == uuid && v.state == want) {
            return Ok(true);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    Ok(false)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let c = connect("kvm", "kvm").await?;
    let (access, version) = vm::access(&c, None).await?;
    check(access == Access::Direct, &format!("accès direct à libvirt {version} (groupe libvirt)"))?;

    let vms = vm::list(&c, access, None).await?;
    let cirros = vms.iter().find(|v| v.name == "cirros-test").ok_or("cirros-test absente")?.clone();
    // Le test peut être relancé : on part d'une VM éteinte.
    if cirros.state != VmState::ShutOff {
        vm::act(&c, access, None, &cirros.uuid, VmAction::ForceOff).await?;
        wait_state(&c, &cirros.uuid, VmState::ShutOff).await?;
    }
    check(vms.iter().any(|v| v.name == "spice-test"), "inventaire : cirros-test et spice-test listées")?;

    vm::act(&c, access, None, &cirros.uuid, VmAction::Start).await?;
    check(wait_state(&c, &cirros.uuid, VmState::Running).await?, "démarrage : cirros-test en marche")?;

    let d = vm::detail(&c, access, None, &cirros.uuid).await?;
    check(matches!(d.graphics, Graphics::Vnc { port: Some(_), public: false, .. }), "écran VNC sur 127.0.0.1 avec son port")?;

    let stats = vm::stats(&c, access, None).await?;
    check(stats.iter().any(|s| s.name == "cirros-test"), "activité CPU/mémoire lue")?;

    vm::act(&c, access, None, &cirros.uuid, VmAction::ForceOff).await?;
    check(wait_state(&c, &cirros.uuid, VmState::ShutOff).await?, "arrêt forcé : cirros-test éteinte")?;

    let spice = vms.iter().find(|v| v.name == "spice-test").ok_or("spice-test absente")?;
    let d = vm::detail(&c, access, None, &spice.uuid).await?;
    check(matches!(d.graphics, Graphics::Spice { .. }), "spice-test reconnue en SPICE")?;

    let other = connect("nokvm", "nokvm").await?;
    let (access, reason) = vm::access(&other, None).await?;
    check(access == Access::Unavailable, &format!("utilisateur sans droits : indisponible ({reason})"))?;

    println!("VM_SMOKE_OK");
    Ok(())
}
