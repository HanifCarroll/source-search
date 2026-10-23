/*
 * context-macos-pim-disclaim
 *
 * Spawns a child process (the macOS PIM helper) with a clean TCC
 * responsibility slate, so macOS attributes the Calendar/Contacts privacy
 * request to the helper itself rather than to the process that launched it
 * (Terminal, launchd, or the agent runtime).
 *
 * macOS keys TCC grants to the "responsible process" in the launch chain.
 * A CLI spawned from a terminal or launchd inherits its parent's
 * responsibility, which usually lacks the privacy entitlements, so TCC
 * silently denies the prompt. Disclaiming responsibility on spawn makes the
 * child its own responsible process, letting the helper's own entitlements
 * and usage descriptions apply. This is the same mechanism Chromium, Qt, and
 * Firefox use for privileged helpers.
 *
 * The private libSystem function responsibility_spawnattrs_setdisclaim is
 * declared here directly; it has been stable across macOS releases.
 *
 * Usage: context-macos-pim-disclaim <helper> [args...]
 * Exit code: the child's exit code.
 */
#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);

int main(int argc, char *argv[]) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s <helper> [args...]\n", argv[0]);
    return 2;
  }

  posix_spawnattr_t attrs;
  if (posix_spawnattr_init(&attrs) != 0) {
    perror("posix_spawnattr_init");
    return 1;
  }

  /* Give the child its own responsibility slate for TCC attribution. */
  responsibility_spawnattrs_setdisclaim(&attrs, 1);

  pid_t pid;
  int spawnErr = posix_spawn(&pid, argv[1], NULL, &attrs, &argv[1], environ);
  posix_spawnattr_destroy(&attrs);

  if (spawnErr != 0) {
    fprintf(stderr, "posix_spawn(%s) failed: %s\n", argv[1], strerror(spawnErr));
    return 1;
  }

  int status = 0;
  if (waitpid(pid, &status, 0) == -1) {
    perror("waitpid");
    return 1;
  }

  if (WIFEXITED(status)) {
    return WEXITSTATUS(status);
  }
  if (WIFSIGNALED(status)) {
    fprintf(stderr, "child terminated by signal %d\n", WTERMSIG(status));
    return 128 + WTERMSIG(status);
  }
  return 1;
}
