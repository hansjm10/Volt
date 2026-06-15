import shlex
from pathlib import Path, PurePosixPath

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths
from harbor.utils.env import parse_bool_env_value


class VoltAgent(BaseInstalledAgent):
    """Harbor installed-agent wrapper for Volt."""

    _OUTPUT_FILENAME = "volt-output.txt"
    _REMOTE_VOLT_HOME = PurePosixPath("/tmp/volt-home")
    _REMOTE_VOLT_SECRETS_DIR = PurePosixPath("/tmp/volt-secrets")

    def __init__(
        self,
        *args,
        provider: str | None = None,
        model: str | None = None,
        install_spec: str | None = None,
        source_url: str | None = None,
        source_ref: str | None = None,
        tools: str | None = "read,bash,edit,write,grep,find,ls",
        exclude_tools: str | None = "ask_question",
        extra_args: str | None = None,
        approve: bool | str = True,
        auth_json_path: str | None = None,
        force_auth_json: bool | str = False,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self.provider = provider
        self.model = model
        self.install_spec = install_spec
        self.source_url = source_url
        self.source_ref = source_ref
        self.tools = tools
        self.exclude_tools = exclude_tools
        self.extra_args = extra_args
        self.approve = parse_bool_env_value(approve, name="approve")
        self.auth_json_path = auth_json_path
        self.force_auth_json = parse_bool_env_value(force_auth_json, name="force_auth_json")

    @staticmethod
    def name() -> str:
        return "volt"

    def get_version_command(self) -> str | None:
        return "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; volt --version"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                "if ldd --version 2>&1 | grep -qi musl || [ -f /etc/alpine-release ]; then"
                "  apk add --no-cache bash curl git nodejs npm ripgrep;"
                " elif command -v apt-get &>/dev/null; then"
                "  apt-get update && apt-get install -y bash curl git ripgrep;"
                " elif command -v yum &>/dev/null; then"
                "  yum install -y bash curl git ripgrep;"
                " else"
                '  echo "Warning: No known package manager found, assuming bash, curl, git, and npm are available" >&2;'
                " fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

        install_spec = self.install_spec or self._get_env("VOLT_TBENCH_INSTALL_SPEC")
        install_command = (
            self._npm_install_command(install_spec)
            if install_spec
            else self._source_install_command()
        )
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "if ldd --version 2>&1 | grep -qi musl || [ -f /etc/alpine-release ]; then"
                f"  {install_command}"
                " else"
                "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash &&"
                '  export NVM_DIR="$HOME/.nvm" &&'
                '  \\. "$NVM_DIR/nvm.sh" || true &&'
                "  command -v nvm &>/dev/null || { echo 'Error: NVM failed to load' >&2; exit 1; } &&"
                "  nvm install 22 && nvm alias default 22 &&"
                f"  {install_command}"
                " fi && "
                "volt --version"
            ),
        )

        await self.exec_as_root(
            environment,
            command=(
                "for bin in node npm volt; do"
                '  BIN_PATH="$(which "$bin" 2>/dev/null || true)";'
                '  if [ -n "$BIN_PATH" ] && [ "$BIN_PATH" != "/usr/local/bin/$bin" ]; then'
                '    ln -sf "$BIN_PATH" "/usr/local/bin/$bin";'
                "  fi;"
                " done"
            ),
        )

    def _source_install_command(self) -> str:
        source_url = (
            self.source_url
            or self._get_env("VOLT_TBENCH_SOURCE_URL")
            or "https://github.com/hansjm10/Volt.git"
        )
        source_ref = self.source_ref or self._get_env("VOLT_TBENCH_SOURCE_REF") or "main"
        source_dir = "/tmp/volt-source"
        release_dir = "/tmp/volt-local-release"
        return " ".join(
            [
                f"rm -rf {shlex.quote(source_dir)} {shlex.quote(release_dir)} &&",
                f"git init {shlex.quote(source_dir)} &&",
                f"cd {shlex.quote(source_dir)} &&",
                f"git remote add origin {shlex.quote(source_url)} &&",
                f"git fetch --depth 1 origin {shlex.quote(source_ref)} &&",
                "git checkout --detach FETCH_HEAD &&",
                "npm ci --ignore-scripts &&",
                f"node scripts/local-release.mjs --out {shlex.quote(release_dir)} --force --skip-check --skip-install &&",
                f"npm install -g --ignore-scripts {shlex.quote(release_dir)}/tarballs/*.tgz;",
            ]
        )

    def _npm_install_command(self, install_spec: str) -> str:
        return f"npm install -g --ignore-scripts {shlex.quote(install_spec)};"

    def _resolved_model_args(self) -> list[str]:
        if self.provider and self.model:
            return ["--provider", self.provider, "--model", self.model]
        if self.model:
            return ["--model", self.model]
        if self.model_name:
            return ["--model", self.model_name]
        return []

    def _resolve_auth_json_path(self) -> Path | None:
        explicit = self.auth_json_path or self._get_env("VOLT_AUTH_JSON_PATH")
        if explicit:
            path = Path(explicit).expanduser()
            if not path.is_file():
                raise ValueError(f"VOLT_AUTH_JSON_PATH does not exist: {path}")
            return path

        force = self.force_auth_json
        env_force = self._get_env("VOLT_FORCE_AUTH_JSON")
        if env_force is not None:
            force = parse_bool_env_value(env_force, name="VOLT_FORCE_AUTH_JSON")
        if force:
            default = Path.home() / ".volt" / "agent" / "auth.json"
            if not default.is_file():
                raise ValueError(f"VOLT_FORCE_AUTH_JSON is set but {default} does not exist")
            return default

        return None

    async def _prepare_auth(self, environment: BaseEnvironment, env: dict[str, str]) -> None:
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {shlex.quote(self._REMOTE_VOLT_HOME.as_posix())} "
                f"{shlex.quote(self._REMOTE_VOLT_SECRETS_DIR.as_posix())} "
                f"{shlex.quote(EnvironmentPaths.agent_dir.as_posix())}"
            ),
            env=env,
        )

        auth_json_path = self._resolve_auth_json_path()
        if not auth_json_path:
            return

        remote_auth_path = (self._REMOTE_VOLT_SECRETS_DIR / "auth.json").as_posix()
        await environment.upload_file(auth_json_path, remote_auth_path)
        if environment.default_user is not None:
            await self.exec_as_root(
                environment,
                command=f"chown {environment.default_user} {shlex.quote(remote_auth_path)}",
            )
        await self.exec_as_agent(
            environment,
            command=(
                'mkdir -p "$VOLT_CODING_AGENT_DIR" && '
                f"ln -sf {shlex.quote(remote_auth_path)} "
                '"$VOLT_CODING_AGENT_DIR/auth.json"'
            ),
            env=env,
        )

    def _build_command(self, instruction: str) -> str:
        args = [
            "volt",
            "--no-prompt-templates",
            "--no-context-files",
            "-p",
        ]
        if self.approve:
            args.append("--approve")
        if self.tools:
            args.extend(["--tools", self.tools])
        if self.exclude_tools:
            args.extend(["--exclude-tools", self.exclude_tools])
        args.extend(self._resolved_model_args())
        if self.extra_args:
            args.extend(shlex.split(self.extra_args))
        args.append(instruction)
        return " ".join(shlex.quote(arg) for arg in args)

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        env = {
            "VOLT_CODING_AGENT_DIR": (self._REMOTE_VOLT_HOME / "agent").as_posix(),
            "VOLT_CODING_AGENT_SESSION_DIR": (EnvironmentPaths.agent_dir / "sessions").as_posix(),
        }
        await self._prepare_auth(environment, env)

        output_path = EnvironmentPaths.agent_dir / self._OUTPUT_FILENAME
        try:
            await self.exec_as_agent(
                environment,
                command=(
                    "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; "
                    f"{self._build_command(instruction)} "
                    f"2>&1 </dev/null | tee {shlex.quote(output_path.as_posix())}"
                ),
                env=env,
            )
        finally:
            try:
                await self.exec_as_agent(
                    environment,
                    command=(
                        f"rm -rf {shlex.quote(self._REMOTE_VOLT_SECRETS_DIR.as_posix())} "
                        f"{shlex.quote(self._REMOTE_VOLT_HOME.as_posix())}"
                    ),
                    env=env,
                )
            except Exception:
                pass
