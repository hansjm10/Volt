import json
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
    _REMOTE_PROJECT_VOLT_DIR = PurePosixPath("/app/.volt")
    _INHERITED_AGENT_FILES = ("settings.json",)
    _INHERITED_AGENT_DIRS = ("git", "npm", "extensions", "skills", "prompts", "themes")

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
        inherit_agent_dir: bool | str = False,
        agent_dir_path: str | None = None,
        project_volt_dir: str | None = None,
        no_context_files: bool | str = True,
        no_prompt_templates: bool | str = False,
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
        self.inherit_agent_dir = parse_bool_env_value(inherit_agent_dir, name="inherit_agent_dir")
        self.agent_dir_path = agent_dir_path
        self.project_volt_dir = project_volt_dir
        self.no_context_files = parse_bool_env_value(no_context_files, name="no_context_files")
        self.no_prompt_templates = parse_bool_env_value(no_prompt_templates, name="no_prompt_templates")

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

    def _resolve_agent_dir_path(self) -> Path:
        explicit = self.agent_dir_path or self._get_env("VOLT_TBENCH_AGENT_DIR")
        if explicit:
            return Path(explicit).expanduser()
        return Path.home() / ".volt" / "agent"

    def _resolve_project_volt_dir(self) -> Path | None:
        explicit = self.project_volt_dir or self._get_env("VOLT_TBENCH_PROJECT_VOLT_DIR")
        if not explicit:
            return None
        path = Path(explicit).expanduser()
        if not path.is_dir():
            raise ValueError(f"project_volt_dir does not exist: {path}")
        return path

    async def _chown_remote_path(self, environment: BaseEnvironment, remote_path: PurePosixPath) -> None:
        if environment.default_user is None:
            return
        await self.exec_as_root(
            environment,
            command=f"chown -R {environment.default_user} {shlex.quote(remote_path.as_posix())}",
        )

    async def _prepare_inherited_agent_dir(self, environment: BaseEnvironment, env: dict[str, str]) -> None:
        if not self.inherit_agent_dir:
            return

        local_agent_dir = self._resolve_agent_dir_path()
        if not local_agent_dir.is_dir():
            raise ValueError(f"agent_dir_path does not exist: {local_agent_dir}")

        remote_agent_dir = self._REMOTE_VOLT_HOME / "agent"
        await self.exec_as_agent(
            environment,
            command=f"mkdir -p {shlex.quote(remote_agent_dir.as_posix())}",
            env=env,
        )

        for filename in self._INHERITED_AGENT_FILES:
            source = local_agent_dir / filename
            if source.is_file():
                await environment.upload_file(source, (remote_agent_dir / filename).as_posix())

        for dirname in self._INHERITED_AGENT_DIRS:
            source = local_agent_dir / dirname
            if not source.is_dir():
                continue
            target = remote_agent_dir / dirname
            await self.exec_as_agent(
                environment,
                command=f"mkdir -p {shlex.quote(target.as_posix())}",
                env=env,
            )
            await environment.upload_dir(source, target.as_posix())

        await self._chown_remote_path(environment, remote_agent_dir)

    async def _prepare_project_volt_dir(self, environment: BaseEnvironment) -> None:
        local_project_volt_dir = self._resolve_project_volt_dir()
        if local_project_volt_dir is None:
            return

        await self.exec_as_root(
            environment,
            command=f"rm -rf {shlex.quote(self._REMOTE_PROJECT_VOLT_DIR.as_posix())}",
        )
        await self.exec_as_root(
            environment,
            command=f"mkdir -p {shlex.quote(self._REMOTE_PROJECT_VOLT_DIR.as_posix())}",
        )
        await environment.upload_dir(local_project_volt_dir, self._REMOTE_PROJECT_VOLT_DIR.as_posix())
        await self._chown_remote_path(environment, self._REMOTE_PROJECT_VOLT_DIR)

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

        await self._prepare_inherited_agent_dir(environment, env)
        await self._prepare_project_volt_dir(environment)

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
            "-p",
        ]
        if self.no_prompt_templates:
            args.append("--no-prompt-templates")
        if self.no_context_files:
            args.append("--no-context-files")
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

    def _populate_usage_from_sessions(self, context: AgentContext) -> None:
        sessions_dir = self.logs_dir / "sessions"
        if not sessions_dir.is_dir():
            return

        message_count = 0
        input_tokens = 0
        cache_read_tokens = 0
        cache_write_tokens = 0
        output_tokens = 0
        total_tokens = 0
        cost_usd = 0.0
        saw_cost = False
        session_files = 0

        for session_path in sorted(sessions_dir.glob("*.jsonl")):
            session_files += 1
            with session_path.open("r", encoding="utf-8") as session_file:
                for line in session_file:
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    message = event.get("message")
                    if not isinstance(message, dict):
                        continue
                    usage = message.get("usage")
                    if not isinstance(usage, dict):
                        continue

                    message_count += 1
                    input_tokens += int(usage.get("input") or 0)
                    cache_read_tokens += int(usage.get("cacheRead") or 0)
                    cache_write_tokens += int(usage.get("cacheWrite") or 0)
                    output_tokens += int(usage.get("output") or 0)
                    total_tokens += int(usage.get("totalTokens") or 0)

                    cost = usage.get("cost")
                    total_cost = cost.get("total") if isinstance(cost, dict) else None
                    if isinstance(total_cost, (int, float)):
                        cost_usd += float(total_cost)
                        saw_cost = True

        if message_count == 0:
            return

        cache_tokens = cache_read_tokens + cache_write_tokens
        context.n_input_tokens = input_tokens + cache_tokens
        context.n_cache_tokens = cache_tokens
        context.n_output_tokens = output_tokens
        context.cost_usd = cost_usd if saw_cost else None

        metadata = dict(context.metadata or {})
        metadata["volt_usage"] = {
            "message_count": message_count,
            "session_files": session_files,
            "input_tokens_excluding_cache": input_tokens,
            "cache_read_tokens": cache_read_tokens,
            "cache_write_tokens": cache_write_tokens,
            "total_tokens": total_tokens,
        }
        context.metadata = metadata

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
                self._populate_usage_from_sessions(context)
            except Exception as exc:
                self.logger.warning("Failed to collect Volt usage metadata: %s", exc)

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
