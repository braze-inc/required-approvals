const test = require("node:test");
const assert = require("node:assert");
const fs = require('node:fs');
const { getCodeowners } = require("../src/getCodeowners");

test('getCodeowners', { concurrency: true }, (t) => {
  const codeownersData = fs.readFileSync("./test/codeowners.txt", "utf8");

  t.test("files with direct codeowner match", () => {
    const codeowners = getCodeowners(codeownersData, [
      "shared_code/domains/channel_webhook/public/braze/msg_pipeline/checks/webhook/url_is_not_blocked.rb",
    ]);
    assert.deepStrictEqual(codeowners, ["push"]);
  });

  t.test("files with directory-level codeowner match", () => {
    const codeowners = getCodeowners(codeownersData, [
      "/shared_code/domains/channel_webhook/public/braze/msg_pipeline/checks/webhook/url_is_not_blocked.rb",
    ]);
    assert.deepStrictEqual(codeowners, ["push"]);
  });

  t.test("changes with multiple codeowners", () => {
    const codeowners = getCodeowners(codeownersData, [
      "shared_code/domains/channel_webhook/public/braze/msg_pipeline/checks/webhook/url_is_not_blocked.rb",
      "shared_code/domains/channel_webhook/public/braze/msg_pipeline/checks/webhook/url_is_not_unreachable.rb",
      "shared_code/domains/channel_webhook/public/braze/msg_pipeline/checks/webhook/url_is_rendered.rb",
      "shared_code/domains/chat_messaging_pipeline/public/braze/msg_pipeline/hooks/chat/log_sender_events_to_currents.rb",
      "shared_code/domains/messaging_pipeline/public/braze/msg_pipeline/checks/message_is_rendered.rb",
      "shared_code/domains/messaging_pipeline/public/braze/msg_pipeline/checks/send_is_not_too_old.rb",
      "shared_code/domains/sms_messaging_pipeline/public/braze/msg_pipeline/checks/chat/SMS/liquid_is_templated.rb",
      "shared_code/lib/shared/braze/msg_pipeline/checks/user_did_not_perform_exit_criteria_event.rb",
      "shared_code/lib/shared/braze/msg_pipeline/checks/user_is_capable_of_receiving_email.rb",
      "shared_code/lib/shared/braze/msg_pipeline/checks/user_is_capable_of_receiving_push.rb",
      "shared_code/lib/shared/braze/msg_pipeline/hooks/exit_users_from_canvas.rb",
    ]);
    assert.deepStrictEqual(codeowners, ["push", "sms", "whats-app", "core-messaging", "clx", "email"]);
  });

  t.test("changes with multiple codeowners on a single file", () => {
    const codeowners = getCodeowners(codeownersData, [
      "/shared_code/domains/chat_messaging_pipeline/public/braze/msg_pipeline/hooks/chat/log_sender_events_to_currents.rb",
    ]);
    assert.deepStrictEqual(codeowners, ["sms", "whats-app"]);
  });

  t.test("changes with no codeowners", () => {
    const codeowners = getCodeowners(codeownersData, ["blah.rb"]);
    assert.deepStrictEqual(codeowners, []);
  });

  t.test("changes that would match multiple rules", () => {
    /*
    These rules should result in only frontend-ix being the owner, as later rules override earlier ones.

    ```
      /containers/dashboard/ @Appboy/sidekiq-and-monolith-foundations
      /containers/dashboard/Dockerfile.test.frontend @Appboy/frontend-ix
    ```
    */
    const codeowners = getCodeowners(codeownersData, [
      "/containers/dashboard/Dockerfile.test.frontend",
    ]);
    assert.deepStrictEqual(codeowners, ["frontend-ix"]);
  });

  t.test("changes to files with spaces in the name", () => {
    const codeowners = getCodeowners(codeownersData, [
      "/containers/dashboard/Docker Thing.test",
    ]);
    assert.deepStrictEqual(codeowners, ["frontend-ix"]);
  });
});