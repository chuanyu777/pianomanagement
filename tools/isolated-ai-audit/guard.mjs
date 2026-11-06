export function validateDatabaseContainer(c, project, service) {
  const labels=c.Config?.Labels ?? {};
  const ports=c.NetworkSettings?.Ports ?? {};
  const networks=Object.keys(c.NetworkSettings?.Networks ?? {});
  if (!/^piano-isolated-[a-f0-9]{12}$/.test(project) || labels['com.docker.compose.project']!==project || labels['com.docker.compose.service']!==service || c.HostConfig?.NetworkMode!==`${project}_private` || networks.length!==1 || networks[0]!==`${project}_private` || !Object.hasOwn(c.HostConfig?.Tmpfs ?? {}, '/var/lib/postgresql/data') || c.Mounts?.length !== 0 || Object.values(ports).some(Boolean) || Object.keys(c.HostConfig?.PortBindings ?? {}).length) throw new Error('UNSAFE_DATABASE_CONTAINER');
}
