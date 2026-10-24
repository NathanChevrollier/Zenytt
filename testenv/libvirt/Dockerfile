# Serveur de test « hôte de VM » : libvirt + QEMU en émulation (TCG, pas besoin de /dev/kvm).
FROM debian:bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server sudo libvirt-daemon-system libvirt-clients qemu-system-x86 qemu-utils \
      ovmf curl ca-certificates dnsmasq-base iptables \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd \
    && echo 'root:zenytt' | chpasswd \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config \
    && useradd -m -s /bin/bash -g kvm -G libvirt kvm && echo 'kvm:kvm' | chpasswd \
    && useradd -m -s /bin/bash nokvm && echo 'nokvm:nokvm' | chpasswd
# Accès au socket par le groupe libvirt, sans polkit (pas de D-Bus dans le conteneur) : c'est le
# réglage courant d'un serveur où l'administrateur est « membre du groupe libvirt ».
RUN printf '%s\n' 'unix_sock_group = "libvirt"' 'unix_sock_rw_perms = "0770"' 'auth_unix_rw = "none"' 'auth_unix_ro = "none"' >> /etc/libvirt/libvirtd.conf
# Dans un conteneur (runners GitHub en cgroup v2), libvirt ne peut pas créer le cgroup de la VM :
# on le désactive, ce qui ne change rien au pilotage testé ici.
RUN printf '%s\n' 'cgroup_controllers = [ ]' >> /etc/libvirt/qemu.conf
# Image CirrOS (15 Mo) : démarre même en émulation.
# Site officiel parfois lent : plusieurs essais, puis la copie publiée sur GitHub.
RUN for u in https://download.cirros-cloud.net/0.6.2/cirros-0.6.2-x86_64-disk.img \
             https://github.com/cirros-dev/cirros/releases/download/0.6.2/cirros-0.6.2-x86_64-disk.img; do \
      curl -fsSL --retry 3 --retry-all-errors --connect-timeout 20 --max-time 300 -o /var/lib/libvirt/images/cirros.qcow2 "$u" && exit 0; \
    done; exit 1
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 22
CMD ["/entrypoint.sh"]
