#!/usr/bin/env bash
set -e
set -o pipefail

docker compose --profile migration --profile notification-delivery-migration --profile notification-delivery-database --profile campaigns-migration --profile campaigns-database --profile reporting-migration --profile reporting-database --profile widgets-migration --profile widgets-database --profile billing-migration --profile billing-database --profile identity-migration --profile identity-database --env-file .env.example -f deploy/docker-compose.prod.yml config --quiet
# shellcheck disable=SC2016
docker compose --profile migration --profile notification-delivery-migration --profile notification-delivery-database --profile campaigns-migration --profile campaigns-database --profile reporting-migration --profile reporting-database --profile widgets-migration --profile widgets-database --profile billing-migration --profile billing-database --profile identity-migration --profile identity-database --env-file .env.example -f deploy/docker-compose.prod.yml config --format json |
  node -e '
    const { readFileSync } = require("node:fs");
    const config = JSON.parse(readFileSync(0, "utf8"));
    const restoreGateExampleLines = readFileSync(
      ".env.example",
      "utf8",
    )
      .split("\n")
      .filter(line =>
        line.startsWith("DATABASE_RESTORE_PRODUCTION_ENABLED="),
      );
    if (
      restoreGateExampleLines.length !== 1 ||
      restoreGateExampleLines[0] !==
        "DATABASE_RESTORE_PRODUCTION_ENABLED=false"
    ) {
      throw new Error(
        ".env.example must keep the database restore production gate disabled",
      );
    }
    const services = config.services ?? {};
    if (config.name !== "winwidget") {
      throw new Error(`Unexpected Compose project name: ${config.name}`);
    }
    for (const [name, service] of Object.entries(services)) {
      if ("container_name" in service) {
        throw new Error(`${name} must use the standard Compose container name`);
      }
    }
    const rabbitVolume = config.volumes?.["winwidget-rabbitmq-data"];
    if (!rabbitVolume?.external || !rabbitVolume.name) {
      throw new Error("RabbitMQ must use a named external volume");
    }
    const notificationPostgresVolume =
      config.volumes?.["winwidget-notification-delivery-postgres-data"];
    if (
      !notificationPostgresVolume?.external ||
      notificationPostgresVolume.name !==
        process.env.NOTIFICATION_DELIVERY_POSTGRES_DATA_VOLUME
    ) {
      throw new Error(
        "Notification Delivery PostgreSQL must use its exact external volume",
      );
    }
    const notificationPostgresSecret =
      config.secrets?.[
        "notification-delivery-postgres-admin-password"
      ];
    if (
      notificationPostgresSecret?.file !==
      process.env.NOTIFICATION_DELIVERY_POSTGRES_ADMIN_PASSWORD_FILE
    ) {
      throw new Error(
        "Notification Delivery PostgreSQL must use its admin password file secret",
      );
    }
    const campaignsPostgresVolume =
      config.volumes?.["winwidget-campaigns-postgres-data"];
    if (
      !campaignsPostgresVolume?.external ||
      campaignsPostgresVolume.name !==
        process.env.CAMPAIGNS_POSTGRES_DATA_VOLUME
    ) {
      throw new Error(
        "Campaigns PostgreSQL must use its exact external volume",
      );
    }
    const campaignsPostgresSecret =
      config.secrets?.["campaigns-postgres-admin-password"];
    if (
      campaignsPostgresSecret?.file !==
      process.env.CAMPAIGNS_POSTGRES_ADMIN_PASSWORD_FILE
    ) {
      throw new Error(
        "Campaigns PostgreSQL must use its admin password file secret",
      );
    }
    const reportingPostgresVolume =
      config.volumes?.["winwidget-reporting-postgres-data"];
    if (
      !reportingPostgresVolume?.external ||
      reportingPostgresVolume.name !==
        process.env.REPORTING_POSTGRES_DATA_VOLUME
    ) {
      throw new Error(
        "Reporting PostgreSQL must use its exact external volume",
      );
    }
    const reportingPostgresSecret =
      config.secrets?.["reporting-postgres-admin-password"];
    if (
      reportingPostgresSecret?.file !==
      process.env.REPORTING_POSTGRES_ADMIN_PASSWORD_FILE
    ) {
      throw new Error(
        "Reporting PostgreSQL must use its admin password file secret",
      );
    }
    const widgetsPostgresVolume =
      config.volumes?.["winwidget-widgets-postgres-data"];
    if (
      !widgetsPostgresVolume?.external ||
      widgetsPostgresVolume.name !==
        process.env.WIDGETS_POSTGRES_DATA_VOLUME
    ) {
      throw new Error(
        "Widgets PostgreSQL must use its exact external volume",
      );
    }
    const widgetsPostgresSecret =
      config.secrets?.["widgets-postgres-admin-password"];
    if (
      widgetsPostgresSecret?.file !==
      process.env.WIDGETS_POSTGRES_ADMIN_PASSWORD_FILE
    ) {
      throw new Error(
        "Widgets PostgreSQL must use its admin password file secret",
      );
    }
    const billingPostgresVolume =
      config.volumes?.["winwidget-billing-postgres-data"];
    if (
      !billingPostgresVolume?.external ||
      billingPostgresVolume.name !==
        process.env.BILLING_POSTGRES_DATA_VOLUME
    ) {
      throw new Error(
        "Billing PostgreSQL must use its exact external volume",
      );
    }
    const billingPostgresSecret =
      config.secrets?.["billing-postgres-admin-password"];
    if (
      billingPostgresSecret?.file !==
      process.env.BILLING_POSTGRES_ADMIN_PASSWORD_FILE
    ) {
      throw new Error(
        "Billing PostgreSQL must use its admin password file secret",
      );
    }
    const identityPostgresVolume =
      config.volumes?.["winwidget-identity-postgres-data"];
    if (
      !identityPostgresVolume?.external ||
      identityPostgresVolume.name !==
        process.env.IDENTITY_POSTGRES_DATA_VOLUME
    ) {
      throw new Error(
        "Identity PostgreSQL must use its exact external volume",
      );
    }
    const identityPostgresSecret =
      config.secrets?.["identity-postgres-admin-password"];
    if (
      identityPostgresSecret?.file !==
      process.env.IDENTITY_POSTGRES_ADMIN_PASSWORD_FILE
    ) {
      throw new Error(
        "Identity PostgreSQL must use its admin password file secret",
      );
    }
    const coreRestoreSecret =
      config.secrets?.["core-postgres-admin-password"];
    if (
      coreRestoreSecret?.file !==
      process.env.CORE_POSTGRES_ADMIN_PASSWORD_FILE
    ) {
      throw new Error(
        "Database restore worker must use the canonical Core admin password file secret",
      );
    }
    const persistentServiceNames = Object.entries(services)
      .filter(([, service]) => (service.profiles ?? []).length === 0)
      .map(([name]) => name)
      .sort();
    const expectedPersistentServiceNames = [
      "api",
      "api-gateway",
      "billing-api",
      "billing-outbox-publisher",
      "billing-scheduler",
      "billing-worker",
      "campaigns-service",
      "database-restore-worker",
      "identity-api",
      "identity-outbox-publisher",
      "identity-worker",
      "integration-worker",
      "maintenance-worker",
      "notification-delivery-worker",
      "outbox-publisher",
      "rabbitmq",
      "reporting-service",
      "widgets-service",
    ];
    if (
      JSON.stringify(persistentServiceNames) !==
      JSON.stringify(expectedPersistentServiceNames)
    ) {
      throw new Error(
        `Unexpected persistent services: ${persistentServiceNames.join(",")}`,
      );
    }

    const requireService = name => {
      const service = services[name];
      if (!service) throw new Error(`Missing production service ${name}`);
      return service;
    };
    const requireCommand = (name, expected) => {
      const command = requireService(name).command;
      const normalized = Array.isArray(command)
        ? command.join(" ")
        : String(command ?? "");
      if (normalized !== expected) {
        throw new Error(`Unexpected ${name} command: ${normalized}`);
      }
    };
    const requireEnvironment = (name, keys, allowEmpty = []) => {
      const environment = requireService(name).environment ?? {};
      for (const key of keys) {
        if (
          !(key in environment) ||
          (environment[key] === "" && !allowEmpty.includes(key))
        ) {
          throw new Error(`Missing ${key} in production ${name} environment`);
        }
      }
      return environment;
    };
    const notificationPostgres = requireService(
      "notification-delivery-postgres",
    );
    if (
      notificationPostgres.image !==
      process.env.NOTIFICATION_DELIVERY_POSTGRES_IMAGE
    ) {
      throw new Error(
        "Notification Delivery PostgreSQL image must be explicitly configured",
      );
    }
    const notificationPostgresEnvironment = requireEnvironment(
      "notification-delivery-postgres",
      [
        "POSTGRES_DB",
        "POSTGRES_USER",
        "POSTGRES_PASSWORD_FILE",
        "POSTGRES_INITDB_ARGS",
        "PGDATA",
      ],
    );
    if (
      notificationPostgresEnvironment.POSTGRES_DB !==
        "winwidget_notification_delivery" ||
      notificationPostgresEnvironment.POSTGRES_USER !==
        process.env.NOTIFICATION_DELIVERY_POSTGRES_ADMIN_USER ||
      notificationPostgresEnvironment.POSTGRES_PASSWORD_FILE !==
        "/run/secrets/notification-delivery-postgres-admin-password" ||
      notificationPostgresEnvironment.POSTGRES_INITDB_ARGS !==
        "--locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums" ||
      notificationPostgresEnvironment.PGDATA !==
        "/var/lib/postgresql/18/docker"
    ) {
      throw new Error(
        "Notification Delivery PostgreSQL initialization is unsafe",
      );
    }
    const notificationPostgresPorts =
      notificationPostgres.ports ?? [];
    if (
      notificationPostgresPorts.length !== 1 ||
      notificationPostgresPorts[0].host_ip !== "127.0.0.1" ||
      String(notificationPostgresPorts[0].published) !==
        process.env.NOTIFICATION_DELIVERY_POSTGRES_PORT ||
      Number(notificationPostgresPorts[0].target) !== 5432
    ) {
      throw new Error(
        "Notification Delivery PostgreSQL must publish only 127.0.0.1:55432",
      );
    }
    const notificationPostgresNetworks =
      notificationPostgres.networks ?? {};
    const notificationPostgresNetwork =
      config.networks?.["notification-delivery-postgres"];
    if (
      Object.keys(notificationPostgresNetworks).length !== 1 ||
      !Object.hasOwn(
        notificationPostgresNetworks,
        "notification-delivery-postgres",
      ) ||
      notificationPostgresNetwork?.name !==
        "winwidget-notification-delivery-postgres" ||
      notificationPostgresNetwork.driver !== "bridge" ||
      notificationPostgresNetwork.internal === true ||
      notificationPostgresNetwork.labels?.["com.winwidget.owner"] !==
        "notification-delivery" ||
      notificationPostgresNetwork.labels?.[
        "com.winwidget.purpose"
      ] !== "postgres-network"
    ) {
      throw new Error(
        "Notification Delivery PostgreSQL must use only its dedicated loopback-published bridge network",
      );
    }
    const notificationPostgresDataMounts = (
      notificationPostgres.volumes ?? []
    ).filter(
      mount =>
        mount.type === "volume" &&
        mount.target === "/var/lib/postgresql",
    );
    if (
      (notificationPostgres.volumes ?? []).length !== 1 ||
      notificationPostgresDataMounts.length !== 1 ||
      notificationPostgresDataMounts[0].source !==
        process.env.NOTIFICATION_DELIVERY_POSTGRES_DATA_VOLUME
    ) {
      throw new Error(
        "Notification Delivery PostgreSQL data mount is not isolated",
      );
    }
    const notificationPostgresSecrets =
      notificationPostgres.secrets ?? [];
    if (
      notificationPostgresSecrets.length !== 1 ||
      notificationPostgresSecrets[0].source !==
        "notification-delivery-postgres-admin-password"
    ) {
      throw new Error(
        "Notification Delivery PostgreSQL receives an unexpected secret set",
      );
    }
    if (
      notificationPostgres.network_mode != null ||
      notificationPostgres.depends_on != null ||
      notificationPostgres.restart !== "unless-stopped" ||
      JSON.stringify(notificationPostgres.profiles ?? []) !==
        JSON.stringify(["notification-delivery-database"])
    ) {
      throw new Error(
        "Notification Delivery PostgreSQL must stay behind its independent lifecycle profile",
      );
    }
    const expectedPostgresHealthcheck = {
      test: [
        "CMD-SHELL",
        "pg_isready --username \"$$POSTGRES_USER\" --dbname \"$$POSTGRES_DB\"",
      ],
      timeout: "5s",
      interval: "10s",
      retries: 12,
      start_period: "10s",
    };
    if (
      JSON.stringify(notificationPostgres.healthcheck) !==
        JSON.stringify(expectedPostgresHealthcheck) ||
      notificationPostgres.stop_grace_period !== "1m0s" ||
      notificationPostgres.shm_size !== "268435456" ||
      notificationPostgres.mem_limit !== "805306368" ||
      notificationPostgres.mem_reservation !== "268435456" ||
      notificationPostgres.cpus !== 1 ||
      notificationPostgres.pids_limit !== 200 ||
      notificationPostgres.logging?.driver !== "json-file" ||
      notificationPostgres.logging?.options?.["max-size"] !== "10m" ||
      notificationPostgres.logging?.options?.["max-file"] !== "5" ||
      notificationPostgres.labels?.["com.winwidget.owner"] !==
        "notification-delivery" ||
      notificationPostgres.labels?.["com.winwidget.purpose"] !==
        "postgres" ||
      Object.keys(notificationPostgres.labels ?? {}).length !== 2
    ) {
      throw new Error(
        "Notification Delivery PostgreSQL runtime safeguards drifted",
      );
    }
    const campaignsPostgres = requireService("campaigns-postgres");
    const campaignsPostgresEnvironment = requireEnvironment(
      "campaigns-postgres",
      [
        "POSTGRES_DB",
        "POSTGRES_USER",
        "POSTGRES_PASSWORD_FILE",
        "POSTGRES_INITDB_ARGS",
        "PGDATA",
      ],
    );
    const campaignsPorts = campaignsPostgres.ports ?? [];
    const campaignsNetwork = config.networks?.["campaigns-postgres"];
    if (
      campaignsPostgres.image !==
        process.env.CAMPAIGNS_POSTGRES_IMAGE ||
      campaignsPostgresEnvironment.POSTGRES_DB !==
        "winwidget_campaigns" ||
      campaignsPostgresEnvironment.POSTGRES_USER !==
        process.env.CAMPAIGNS_POSTGRES_ADMIN_USER ||
      campaignsPostgresEnvironment.POSTGRES_PASSWORD_FILE !==
        "/run/secrets/campaigns-postgres-admin-password" ||
      campaignsPostgresEnvironment.POSTGRES_INITDB_ARGS !==
        "--locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums" ||
      campaignsPostgresEnvironment.PGDATA !==
        "/var/lib/postgresql/18/docker" ||
      campaignsPorts.length !== 1 ||
      campaignsPorts[0].host_ip !== "127.0.0.1" ||
      String(campaignsPorts[0].published) !==
        process.env.CAMPAIGNS_POSTGRES_PORT ||
      Number(campaignsPorts[0].target) !== 5432 ||
      campaignsNetwork?.name !== "winwidget-campaigns-postgres" ||
      campaignsNetwork.driver !== "bridge" ||
      campaignsNetwork.internal === true ||
      campaignsPostgres.profiles?.[0] !== "campaigns-database" ||
      campaignsPostgres.restart !== "unless-stopped" ||
      (campaignsPostgres.volumes ?? []).length !== 1 ||
      campaignsPostgres.volumes[0].source !==
        process.env.CAMPAIGNS_POSTGRES_DATA_VOLUME ||
      campaignsPostgres.volumes[0].target !==
        "/var/lib/postgresql" ||
      (campaignsPostgres.secrets ?? []).length !== 1 ||
      campaignsPostgres.secrets[0].source !==
        "campaigns-postgres-admin-password"
    ) {
      throw new Error(
        "Campaigns PostgreSQL dedicated loopback network or lifecycle safeguards drifted",
      );
    }
    const reportingPostgres = requireService("reporting-postgres");
    const reportingPostgresEnvironment = requireEnvironment(
      "reporting-postgres",
      [
        "POSTGRES_DB",
        "POSTGRES_USER",
        "POSTGRES_PASSWORD_FILE",
        "POSTGRES_INITDB_ARGS",
        "PGDATA",
      ],
    );
    const reportingPorts = reportingPostgres.ports ?? [];
    const reportingNetwork = config.networks?.["reporting-postgres"];
    if (
      reportingPostgres.image !== process.env.REPORTING_POSTGRES_IMAGE ||
      reportingPostgresEnvironment.POSTGRES_DB !==
        "winwidget_reporting" ||
      reportingPostgresEnvironment.POSTGRES_USER !==
        process.env.REPORTING_POSTGRES_ADMIN_USER ||
      reportingPostgresEnvironment.POSTGRES_PASSWORD_FILE !==
        "/run/secrets/reporting-postgres-admin-password" ||
      reportingPostgresEnvironment.POSTGRES_INITDB_ARGS !==
        "--locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums" ||
      reportingPostgresEnvironment.PGDATA !==
        "/var/lib/postgresql/18/docker" ||
      reportingPorts.length !== 1 ||
      reportingPorts[0].host_ip !== "127.0.0.1" ||
      String(reportingPorts[0].published) !==
        process.env.REPORTING_POSTGRES_PORT ||
      Number(reportingPorts[0].target) !== 5432 ||
      reportingNetwork?.name !== "winwidget-reporting-postgres" ||
      reportingNetwork.driver !== "bridge" ||
      reportingNetwork.internal === true ||
      reportingPostgres.profiles?.[0] !== "reporting-database" ||
      reportingPostgres.restart !== "unless-stopped" ||
      (reportingPostgres.volumes ?? []).length !== 1 ||
      reportingPostgres.volumes[0].source !==
        process.env.REPORTING_POSTGRES_DATA_VOLUME ||
      reportingPostgres.volumes[0].target !== "/var/lib/postgresql" ||
      (reportingPostgres.secrets ?? []).length !== 1 ||
      reportingPostgres.secrets[0].source !==
        "reporting-postgres-admin-password"
    ) {
      throw new Error(
        "Reporting PostgreSQL loopback network or lifecycle safeguards drifted",
      );
    }
    const widgetsPostgres = requireService("widgets-postgres");
    const widgetsPostgresEnvironment = requireEnvironment(
      "widgets-postgres",
      [
        "POSTGRES_DB",
        "POSTGRES_USER",
        "POSTGRES_PASSWORD_FILE",
        "POSTGRES_INITDB_ARGS",
        "PGDATA",
      ],
    );
    const widgetsPorts = widgetsPostgres.ports ?? [];
    const widgetsNetwork = config.networks?.["widgets-postgres"];
    if (
      widgetsPostgres.image !== process.env.WIDGETS_POSTGRES_IMAGE ||
      widgetsPostgresEnvironment.POSTGRES_DB !== "winwidget_widgets" ||
      widgetsPostgresEnvironment.POSTGRES_USER !==
        process.env.WIDGETS_POSTGRES_ADMIN_USER ||
      widgetsPostgresEnvironment.POSTGRES_PASSWORD_FILE !==
        "/run/secrets/widgets-postgres-admin-password" ||
      widgetsPostgresEnvironment.POSTGRES_INITDB_ARGS !==
        "--locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums" ||
      widgetsPostgresEnvironment.PGDATA !==
        "/var/lib/postgresql/18/docker" ||
      widgetsPorts.length !== 1 ||
      widgetsPorts[0].host_ip !== "127.0.0.1" ||
      String(widgetsPorts[0].published) !==
        process.env.WIDGETS_POSTGRES_PORT ||
      Number(widgetsPorts[0].target) !== 5432 ||
      widgetsNetwork?.name !== "winwidget-widgets-postgres" ||
      widgetsNetwork.driver !== "bridge" ||
      widgetsNetwork.internal === true ||
      widgetsPostgres.profiles?.[0] !== "widgets-database" ||
      widgetsPostgres.restart !== "unless-stopped" ||
      (widgetsPostgres.volumes ?? []).length !== 1 ||
      widgetsPostgres.volumes[0].source !==
        process.env.WIDGETS_POSTGRES_DATA_VOLUME ||
      widgetsPostgres.volumes[0].target !== "/var/lib/postgresql" ||
      (widgetsPostgres.secrets ?? []).length !== 1 ||
      widgetsPostgres.secrets[0].source !==
        "widgets-postgres-admin-password"
    ) {
      throw new Error(
        "Widgets PostgreSQL loopback network or lifecycle safeguards drifted",
      );
    }
    const billingPostgres = requireService("billing-postgres");
    const billingPostgresEnvironment = requireEnvironment(
      "billing-postgres",
      [
        "POSTGRES_DB",
        "POSTGRES_USER",
        "POSTGRES_PASSWORD_FILE",
        "POSTGRES_INITDB_ARGS",
        "PGDATA",
      ],
    );
    const billingPorts = billingPostgres.ports ?? [];
    const billingNetworks = billingPostgres.networks ?? {};
    const billingNetwork = config.networks?.["billing-postgres"];
    if (
      billingPostgres.image !== process.env.BILLING_POSTGRES_IMAGE ||
      billingPostgresEnvironment.POSTGRES_DB !== "winwidget_billing" ||
      billingPostgresEnvironment.POSTGRES_USER !==
        process.env.BILLING_POSTGRES_ADMIN_USER ||
      billingPostgresEnvironment.POSTGRES_PASSWORD_FILE !==
        "/run/secrets/billing-postgres-admin-password" ||
      billingPostgresEnvironment.POSTGRES_INITDB_ARGS !==
        "--locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums" ||
      billingPostgresEnvironment.PGDATA !==
        "/var/lib/postgresql/18/docker" ||
      billingPorts.length !== 1 ||
      billingPorts[0].host_ip !== "127.0.0.1" ||
      String(billingPorts[0].published) !==
        process.env.BILLING_POSTGRES_PORT ||
      Number(billingPorts[0].target) !== 5432 ||
      Object.keys(billingNetworks).length !== 1 ||
      !Object.hasOwn(billingNetworks, "billing-postgres") ||
      billingNetwork?.name !== "winwidget-billing-postgres" ||
      billingNetwork.driver !== "bridge" ||
      billingNetwork.internal === true ||
      billingNetwork.labels?.["com.winwidget.owner"] !== "billing" ||
      billingNetwork.labels?.["com.winwidget.purpose"] !==
        "postgres-network" ||
      JSON.stringify(billingPostgres.profiles ?? []) !==
        JSON.stringify(["billing-database"]) ||
      billingPostgres.network_mode != null ||
      billingPostgres.depends_on != null ||
      billingPostgres.restart !== "unless-stopped" ||
      (billingPostgres.volumes ?? []).length !== 1 ||
      billingPostgres.volumes[0].type !== "volume" ||
      billingPostgres.volumes[0].source !==
        process.env.BILLING_POSTGRES_DATA_VOLUME ||
      billingPostgres.volumes[0].target !== "/var/lib/postgresql" ||
      (billingPostgres.secrets ?? []).length !== 1 ||
      billingPostgres.secrets[0].source !==
        "billing-postgres-admin-password" ||
      JSON.stringify(billingPostgres.healthcheck) !==
        JSON.stringify(expectedPostgresHealthcheck) ||
      billingPostgres.stop_grace_period !== "1m0s" ||
      billingPostgres.shm_size !== "268435456" ||
      billingPostgres.mem_limit !== "805306368" ||
      billingPostgres.mem_reservation !== "268435456" ||
      billingPostgres.cpus !== 1 ||
      billingPostgres.pids_limit !== 200 ||
      billingPostgres.logging?.driver !== "json-file" ||
      billingPostgres.logging?.options?.["max-size"] !== "10m" ||
      billingPostgres.logging?.options?.["max-file"] !== "5" ||
      billingPostgres.labels?.["com.winwidget.owner"] !== "billing" ||
      billingPostgres.labels?.["com.winwidget.purpose"] !== "postgres" ||
      Object.keys(billingPostgres.labels ?? {}).length !== 2
    ) {
      throw new Error(
        "Billing PostgreSQL dedicated loopback lifecycle safeguards drifted",
      );
    }
    const identityPostgres = requireService("identity-postgres");
    const identityPostgresEnvironment = requireEnvironment(
      "identity-postgres",
      [
        "POSTGRES_DB",
        "POSTGRES_USER",
        "POSTGRES_PASSWORD_FILE",
        "POSTGRES_INITDB_ARGS",
        "PGDATA",
      ],
    );
    const identityPorts = identityPostgres.ports ?? [];
    const identityNetworks = identityPostgres.networks ?? {};
    const identityNetwork = config.networks?.["identity-postgres"];
    if (
      identityPostgres.image !== process.env.IDENTITY_POSTGRES_IMAGE ||
      identityPostgresEnvironment.POSTGRES_DB !== "winwidget_identity" ||
      identityPostgresEnvironment.POSTGRES_USER !==
        process.env.IDENTITY_POSTGRES_ADMIN_USER ||
      identityPostgresEnvironment.POSTGRES_PASSWORD_FILE !==
        "/run/secrets/identity-postgres-admin-password" ||
      identityPostgresEnvironment.POSTGRES_INITDB_ARGS !==
        "--locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums" ||
      identityPostgresEnvironment.PGDATA !==
        "/var/lib/postgresql/18/docker" ||
      identityPorts.length !== 1 ||
      identityPorts[0].host_ip !== "127.0.0.1" ||
      String(identityPorts[0].published) !==
        process.env.IDENTITY_POSTGRES_PORT ||
      Number(identityPorts[0].target) !== 5432 ||
      Object.keys(identityNetworks).length !== 1 ||
      !Object.hasOwn(identityNetworks, "identity-postgres") ||
      identityNetwork?.name !== "winwidget-identity-postgres" ||
      identityNetwork.driver !== "bridge" ||
      identityNetwork.internal === true ||
      identityNetwork.labels?.["com.winwidget.owner"] !== "identity" ||
      identityNetwork.labels?.["com.winwidget.purpose"] !==
        "postgres-network" ||
      JSON.stringify(identityPostgres.profiles ?? []) !==
        JSON.stringify(["identity-database"]) ||
      identityPostgres.network_mode != null ||
      identityPostgres.depends_on != null ||
      identityPostgres.restart !== "unless-stopped" ||
      (identityPostgres.volumes ?? []).length !== 1 ||
      identityPostgres.volumes[0].type !== "volume" ||
      identityPostgres.volumes[0].source !==
        process.env.IDENTITY_POSTGRES_DATA_VOLUME ||
      identityPostgres.volumes[0].target !== "/var/lib/postgresql" ||
      (identityPostgres.secrets ?? []).length !== 1 ||
      identityPostgres.secrets[0].source !==
        "identity-postgres-admin-password" ||
      JSON.stringify(identityPostgres.healthcheck) !==
        JSON.stringify(expectedPostgresHealthcheck) ||
      identityPostgres.stop_grace_period !== "1m0s" ||
      identityPostgres.shm_size !== "268435456" ||
      identityPostgres.mem_limit !== "805306368" ||
      identityPostgres.mem_reservation !== "268435456" ||
      identityPostgres.cpus !== 1 ||
      identityPostgres.pids_limit !== 200 ||
      identityPostgres.logging?.driver !== "json-file" ||
      identityPostgres.logging?.options?.["max-size"] !== "10m" ||
      identityPostgres.logging?.options?.["max-file"] !== "5" ||
      identityPostgres.labels?.["com.winwidget.owner"] !== "identity" ||
      identityPostgres.labels?.["com.winwidget.purpose"] !==
        "postgres" ||
      Object.keys(identityPostgres.labels ?? {}).length !== 2
    ) {
      throw new Error(
        "Identity PostgreSQL dedicated loopback lifecycle safeguards drifted",
      );
    }
    for (const [name, service] of Object.entries(services)) {
      if (
        name === "notification-delivery-postgres" ||
        name === "campaigns-postgres" ||
        name === "reporting-postgres" ||
        name === "widgets-postgres" ||
        name === "billing-postgres" ||
        name === "identity-postgres"
      ) continue;
      if (
        (service.volumes ?? []).some(
          mount =>
            mount.source ===
            process.env.NOTIFICATION_DELIVERY_POSTGRES_DATA_VOLUME,
        ) ||
        (name !== "database-restore-worker" &&
          (service.secrets ?? []).some(
            secret =>
              secret.source ===
              "notification-delivery-postgres-admin-password",
          )) ||
        Object.hasOwn(
          service.networks ?? {},
          "notification-delivery-postgres",
        ) ||
        Object.hasOwn(
          service.depends_on ?? {},
          "notification-delivery-postgres",
        ) ||
        (service.volumes ?? []).some(
          mount =>
            mount.source ===
            process.env.CAMPAIGNS_POSTGRES_DATA_VOLUME,
        ) ||
        (name !== "database-restore-worker" &&
          (service.secrets ?? []).some(
            secret =>
              secret.source ===
              "campaigns-postgres-admin-password",
          )) ||
        Object.hasOwn(
          service.networks ?? {},
          "campaigns-postgres",
        ) ||
        Object.hasOwn(
          service.depends_on ?? {},
          "campaigns-postgres",
        ) ||
        (service.volumes ?? []).some(
          mount =>
            mount.source ===
            process.env.REPORTING_POSTGRES_DATA_VOLUME,
        ) ||
        (name !== "database-restore-worker" &&
          (service.secrets ?? []).some(
            secret =>
              secret.source ===
              "reporting-postgres-admin-password",
          )) ||
        Object.hasOwn(
          service.networks ?? {},
          "reporting-postgres",
        ) ||
        Object.hasOwn(
          service.depends_on ?? {},
          "reporting-postgres",
        ) ||
        (service.volumes ?? []).some(
          mount =>
            mount.source ===
            process.env.WIDGETS_POSTGRES_DATA_VOLUME,
        ) ||
        (name !== "database-restore-worker" &&
          (service.secrets ?? []).some(
            secret =>
              secret.source ===
              "widgets-postgres-admin-password",
          )) ||
        Object.hasOwn(
          service.networks ?? {},
          "widgets-postgres",
        ) ||
        Object.hasOwn(
          service.depends_on ?? {},
          "widgets-postgres",
        ) ||
        (service.volumes ?? []).some(
          mount =>
            mount.source ===
            process.env.BILLING_POSTGRES_DATA_VOLUME,
        ) ||
        (name !== "database-restore-worker" &&
          (service.secrets ?? []).some(
            secret =>
              secret.source ===
              "billing-postgres-admin-password",
          )) ||
        Object.hasOwn(
          service.networks ?? {},
          "billing-postgres",
        ) ||
        Object.hasOwn(
          service.depends_on ?? {},
          "billing-postgres",
        ) ||
        (service.volumes ?? []).some(
          mount =>
            mount.source ===
            process.env.IDENTITY_POSTGRES_DATA_VOLUME,
        ) ||
        (name !== "database-restore-worker" &&
          (service.secrets ?? []).some(
            secret =>
              secret.source ===
              "identity-postgres-admin-password",
          )) ||
        Object.hasOwn(
          service.networks ?? {},
          "identity-postgres",
        ) ||
        Object.hasOwn(
          service.depends_on ?? {},
          "identity-postgres",
        )
      ) {
        throw new Error(
          `${name} must not share a standalone PostgreSQL lifecycle`,
        );
      }
    }
    for (const name of [
      "api",
      "api-gateway",
      "maintenance-worker",
      "database-restore-worker",
      "identity-api",
      "notification-delivery-worker",
      "campaigns-service",
      "reporting-service",
      "widgets-service",
      "billing-api",
    ]) {
      const service = requireService(name);
      const expectedRevision = {
        api: process.env.APP_REVISION,
        "api-gateway": process.env.APP_REVISION,
        "maintenance-worker": process.env.MAINTENANCE_REVISION,
        "database-restore-worker":
          process.env.DATABASE_RESTORE_REVISION,
        "identity-api": process.env.IDENTITY_REVISION,
        "notification-delivery-worker":
          process.env.NOTIFICATION_DELIVERY_REVISION,
        "campaigns-service": process.env.CAMPAIGNS_REVISION,
        "reporting-service": process.env.REPORTING_REVISION,
        "widgets-service": process.env.WIDGETS_REVISION,
        "billing-api": process.env.BILLING_REVISION,
      }[name];
      if (service.build?.args?.APP_REVISION !== expectedRevision) {
        throw new Error(`${name} image build revision is not pinned`);
      }
      const expectedImage = {
        api: `winwidget-api:${process.env.APP_VERSION}`,
        "api-gateway": `winwidget-api-gateway:${process.env.APP_VERSION}`,
        "maintenance-worker": process.env.MAINTENANCE_IMAGE,
        "database-restore-worker": process.env.DATABASE_RESTORE_IMAGE,
        "identity-api": process.env.IDENTITY_IMAGE,
        "notification-delivery-worker":
          process.env.NOTIFICATION_DELIVERY_IMAGE,
        "campaigns-service": process.env.CAMPAIGNS_IMAGE,
        "reporting-service": process.env.REPORTING_IMAGE,
        "widgets-service": process.env.WIDGETS_IMAGE,
        "billing-api": process.env.BILLING_IMAGE,
      }[name];
      if (service.image !== expectedImage) {
        throw new Error(`${name} image tag is not pinned to the revision`);
      }
    }
    if (
      requireService("maintenance-worker").build?.target !==
      "maintenance-runner"
    ) {
      throw new Error(
        "maintenance-worker must use the maintenance-runner image target",
      );
    }
    if (
      requireService("database-restore-worker").build?.target !==
        "database-restore-runner"
    ) {
      throw new Error(
        "database-restore-worker must use its isolated image target",
      );
    }
    const requireStandaloneNotificationBuild = name => {
      const service = requireService(name);
      const build = service.build ?? {};
      if (
        !String(build.context ?? "")
          .replaceAll("\\", "/")
          .endsWith("/apps/notification-delivery") ||
        build.dockerfile !== "Dockerfile" ||
        build.target != null ||
        build.args?.APP_REVISION !==
          process.env.NOTIFICATION_DELIVERY_REVISION ||
        service.image !== process.env.NOTIFICATION_DELIVERY_IMAGE
      ) {
        throw new Error(
          `${name} must use the exact standalone app image and context`,
        );
      }
    };
    requireStandaloneNotificationBuild(
      "notification-delivery-worker",
    );
    requireStandaloneNotificationBuild(
      "notification-delivery-migrate",
    );
    const requireStandaloneCampaignsBuild = name => {
      const service = requireService(name);
      const build = service.build ?? {};
      if (
        !String(build.context ?? "")
          .replaceAll("\\", "/")
          .endsWith("/apps/campaigns") ||
        build.dockerfile !== "Dockerfile" ||
        build.target != null ||
        build.args?.APP_REVISION !==
          process.env.CAMPAIGNS_REVISION ||
        service.image !== process.env.CAMPAIGNS_IMAGE
      ) {
        throw new Error(
          `${name} must use the exact standalone Campaigns image and context`,
        );
      }
    };
    requireStandaloneCampaignsBuild("campaigns-service");
    requireStandaloneCampaignsBuild("campaigns-migrate");
    const requireStandaloneReportingBuild = name => {
      const service = requireService(name);
      const build = service.build ?? {};
      if (
        !String(build.context ?? "")
          .replaceAll("\\", "/")
          .endsWith("/apps/reporting") ||
        build.dockerfile !== "Dockerfile" ||
        build.target != null ||
        build.args?.APP_REVISION !== process.env.REPORTING_REVISION ||
        service.image !== process.env.REPORTING_IMAGE
      ) {
        throw new Error(
          `${name} must use the exact standalone Reporting image and context`,
        );
      }
    };
    requireStandaloneReportingBuild("reporting-service");
    requireStandaloneReportingBuild("reporting-migrate");
    const requireStandaloneWidgetsBuild = name => {
      const service = requireService(name);
      const build = service.build ?? {};
      if (
        !String(build.context ?? "")
          .replaceAll("\\", "/")
          .endsWith("/winwidget.ru_server") ||
        String(build.dockerfile ?? "")
          .replaceAll("\\", "/") !== "apps/widgets/Dockerfile" ||
        build.target != null ||
        build.args?.APP_REVISION !== process.env.WIDGETS_REVISION ||
        service.image !== process.env.WIDGETS_IMAGE
      ) {
        throw new Error(
          `${name} must build the standalone Widgets image from the repository runtime-asset context`,
        );
      }
    };
    requireStandaloneWidgetsBuild("widgets-service");
    requireStandaloneWidgetsBuild("widgets-migrate");
    const requireStandaloneBillingBuild = name => {
      const service = requireService(name);
      const build = service.build ?? {};
      if (
        !String(build.context ?? "")
          .replaceAll("\\", "/")
          .endsWith("/apps/billing") ||
        build.dockerfile !== "Dockerfile" ||
        build.target != null ||
        build.args?.APP_REVISION !== process.env.BILLING_REVISION ||
        service.image !== process.env.BILLING_IMAGE
      ) {
        throw new Error(
          `${name} must use the exact standalone Billing app image and context`,
        );
      }
    };
    requireStandaloneBillingBuild("billing-api");
    requireStandaloneBillingBuild("billing-migrate");
    const requireStandaloneIdentityBuild = name => {
      const service = requireService(name);
      const build = service.build ?? {};
      if (
        !String(build.context ?? "")
          .replaceAll("\\", "/")
          .endsWith("/apps/identity") ||
        build.dockerfile !== "Dockerfile" ||
        build.target != null ||
        build.args?.APP_REVISION !== process.env.IDENTITY_REVISION ||
        service.image !== process.env.IDENTITY_IMAGE
      ) {
        throw new Error(
          `${name} must use the exact standalone Identity app image and context`,
        );
      }
    };
    requireStandaloneIdentityBuild("identity-api");
    requireStandaloneIdentityBuild("identity-migrate");
    for (const name of [
      "identity-api",
      "identity-worker",
      "identity-outbox-publisher",
    ]) {
      if (requireService(name).image !== process.env.IDENTITY_IMAGE) {
        throw new Error(`${name} must share the immutable Identity image`);
      }
    }
    for (const name of [
      "identity-worker",
      "identity-outbox-publisher",
    ]) {
      if (requireService(name).build != null) {
        throw new Error(`${name} must reuse the Identity API image build`);
      }
    }
    for (const name of [
      "billing-api",
      "billing-scheduler",
      "billing-worker",
      "billing-outbox-publisher",
    ]) {
      if (requireService(name).image !== process.env.BILLING_IMAGE) {
        throw new Error(`${name} must share the immutable Billing image`);
      }
    }
    for (const name of [
      "billing-scheduler",
      "billing-worker",
      "billing-outbox-publisher",
    ]) {
      if (requireService(name).build != null) {
        throw new Error(`${name} must reuse the Billing API image build`);
      }
    }
    const requireExactKinds = (environment, key, expected, name) => {
      const kinds = [...new Set(String(environment[key] ?? "")
        .split(",")
        .map(value => value.trim())
        .filter(Boolean))].sort();
      const normalizedExpected = [...expected].sort();
      if (JSON.stringify(kinds) !== JSON.stringify(normalizedExpected)) {
        throw new Error(
          `${key} in ${name} must contain exactly ${normalizedExpected.join(",")}`,
        );
      }
    };

    requireCommand(
      "outbox-publisher",
      "node dist/src/outbox-publisher-main.js",
    );
    requireCommand(
      "integration-worker",
      "node dist/src/integration-worker-main.js",
    );
    requireCommand(
      "migrate",
      "migrate deploy",
    );
    requireCommand(
      "notification-delivery-migrate",
      "migrate deploy --schema prisma/schema.prisma",
    );
    requireCommand(
      "campaigns-migrate",
      "migrate deploy --schema prisma/schema.prisma",
    );
    requireCommand(
      "reporting-migrate",
      "migrate deploy --schema prisma/schema.prisma",
    );
    requireCommand(
      "widgets-migrate",
      "migrate deploy --schema prisma/schema.prisma",
    );
    for (const name of [
      "billing-api",
      "billing-scheduler",
      "billing-worker",
      "billing-outbox-publisher",
    ]) {
      requireCommand(name, "node dist/src/main.js");
    }
    requireCommand(
      "billing-migrate",
      "migrate deploy --schema prisma/schema.prisma",
    );
    for (const name of [
      "identity-api",
      "identity-worker",
      "identity-outbox-publisher",
    ]) {
      requireCommand(name, "node dist/src/main.js");
    }
    requireCommand(
      "identity-migrate",
      "migrate deploy --schema prisma/schema.prisma",
    );
    const migration = requireService("migrate");
    const migrationEntrypoint = Array.isArray(migration.entrypoint)
      ? migration.entrypoint.join(" ")
      : String(migration.entrypoint ?? "");
    if (migrationEntrypoint !== "./node_modules/.bin/prisma") {
      throw new Error(
        `Unexpected migrate entrypoint: ${migrationEntrypoint}`,
      );
    }
    if (!(migration.profiles ?? []).includes("migration")) {
      throw new Error("migrate must remain behind the migration profile");
    }
    const migrationEnvironment = requireEnvironment("migrate", [
      "APP_REVISION",
      "NODE_ENV",
      "DATABASE_URL",
    ]);
    const unexpectedMigrationKeys = Object.keys(
      migrationEnvironment,
    ).filter(
      key =>
        ![
          "APP_REVISION",
          "NODE_ENV",
          "DATABASE_URL",
        ].includes(key),
    );
    if (unexpectedMigrationKeys.length > 0) {
      throw new Error(
        `migrate receives unexpected environment: ${unexpectedMigrationKeys.join(",")}`,
      );
    }
    const notificationMigration = requireService(
      "notification-delivery-migrate",
    );
    const notificationMigrationEntrypoint = Array.isArray(
      notificationMigration.entrypoint,
    )
      ? notificationMigration.entrypoint.join(" ")
      : String(notificationMigration.entrypoint ?? "");
    if (
      notificationMigrationEntrypoint !==
      "./node_modules/.bin/prisma"
    ) {
      throw new Error(
        `Unexpected notification-delivery-migrate entrypoint: ${notificationMigrationEntrypoint}`,
      );
    }
    if (
      !(notificationMigration.profiles ?? []).includes(
        "notification-delivery-migration",
      )
    ) {
      throw new Error(
        "notification-delivery-migrate must remain behind its migration profile",
      );
    }
    const notificationMigrationEnvironment = requireEnvironment(
      "notification-delivery-migrate",
      [
        "APP_REVISION",
        "NODE_ENV",
        "NOTIFICATION_DELIVERY_DATABASE_URL",
      ],
    );
    const unexpectedNotificationMigrationKeys = Object.keys(
      notificationMigrationEnvironment,
    ).filter(
      key =>
        ![
          "APP_REVISION",
          "NODE_ENV",
          "NOTIFICATION_DELIVERY_DATABASE_URL",
        ].includes(key),
    );
    if (unexpectedNotificationMigrationKeys.length > 0) {
      throw new Error(
        `notification-delivery-migrate receives unexpected environment: ${unexpectedNotificationMigrationKeys.join(",")}`,
      );
    }
    const campaignsMigration = requireService("campaigns-migrate");
    const campaignsMigrationEntrypoint = Array.isArray(
      campaignsMigration.entrypoint,
    )
      ? campaignsMigration.entrypoint.join(" ")
      : String(campaignsMigration.entrypoint ?? "");
    if (
      campaignsMigrationEntrypoint !== "./node_modules/.bin/prisma" ||
      !(campaignsMigration.profiles ?? []).includes(
        "campaigns-migration",
      )
    ) {
      throw new Error(
        "campaigns-migrate must use Prisma behind its migration profile",
      );
    }
    const campaignsMigrationEnvironment = requireEnvironment(
      "campaigns-migrate",
      ["APP_REVISION", "NODE_ENV", "CAMPAIGNS_DATABASE_URL"],
    );
    if (
      Object.keys(campaignsMigrationEnvironment).some(
        key =>
          ![
            "APP_REVISION",
            "NODE_ENV",
            "CAMPAIGNS_DATABASE_URL",
          ].includes(key),
      )
    ) {
      throw new Error(
        "campaigns-migrate receives an unexpected environment",
      );
    }
    const reportingMigration = requireService("reporting-migrate");
    const reportingMigrationEntrypoint = Array.isArray(
      reportingMigration.entrypoint,
    )
      ? reportingMigration.entrypoint.join(" ")
      : String(reportingMigration.entrypoint ?? "");
    if (
      reportingMigrationEntrypoint !== "./node_modules/.bin/prisma" ||
      !(reportingMigration.profiles ?? []).includes(
        "reporting-migration",
      )
    ) {
      throw new Error(
        "reporting-migrate must use Prisma behind its migration profile",
      );
    }
    const reportingMigrationEnvironment = requireEnvironment(
      "reporting-migrate",
      ["APP_REVISION", "NODE_ENV", "REPORTING_DATABASE_URL"],
    );
    if (
      Object.keys(reportingMigrationEnvironment).some(
        key =>
          ![
            "APP_REVISION",
            "NODE_ENV",
            "REPORTING_DATABASE_URL",
          ].includes(key),
      )
    ) {
      throw new Error(
        "reporting-migrate receives an unexpected environment",
      );
    }
    const widgetsMigration = requireService("widgets-migrate");
    const widgetsMigrationEntrypoint = Array.isArray(
      widgetsMigration.entrypoint,
    )
      ? widgetsMigration.entrypoint.join(" ")
      : String(widgetsMigration.entrypoint ?? "");
    if (
      widgetsMigrationEntrypoint !== "./node_modules/.bin/prisma" ||
      !(widgetsMigration.profiles ?? []).includes(
        "widgets-migration",
      )
    ) {
      throw new Error(
        "widgets-migrate must use Prisma behind its migration profile",
      );
    }
    const widgetsMigrationEnvironment = requireEnvironment(
      "widgets-migrate",
      ["APP_REVISION", "NODE_ENV", "WIDGETS_DATABASE_URL"],
    );
    if (
      Object.keys(widgetsMigrationEnvironment).some(
        key =>
          ![
            "APP_REVISION",
            "NODE_ENV",
            "WIDGETS_DATABASE_URL",
          ].includes(key),
      )
    ) {
      throw new Error(
        "widgets-migrate receives an unexpected environment",
      );
    }
    const billingMigration = requireService("billing-migrate");
    const billingMigrationEntrypoint = Array.isArray(
      billingMigration.entrypoint,
    )
      ? billingMigration.entrypoint.join(" ")
      : String(billingMigration.entrypoint ?? "");
    if (
      billingMigrationEntrypoint !== "./node_modules/.bin/prisma" ||
      JSON.stringify(billingMigration.profiles ?? []) !==
        JSON.stringify(["billing-migration"]) ||
      billingMigration.network_mode !== "host" ||
      billingMigration.depends_on != null
    ) {
      throw new Error(
        "billing-migrate must use Prisma behind its isolated migration profile",
      );
    }
    const billingMigrationEnvironment = requireEnvironment(
      "billing-migrate",
      ["APP_REVISION", "NODE_ENV", "BILLING_DATABASE_URL"],
    );
    if (
      Object.keys(billingMigrationEnvironment).some(
        key =>
          ![
            "APP_REVISION",
            "NODE_ENV",
            "BILLING_DATABASE_URL",
          ].includes(key),
      )
    ) {
      throw new Error(
        "billing-migrate receives an unexpected environment",
      );
    }
    const identityMigration = requireService("identity-migrate");
    const identityMigrationEntrypoint = Array.isArray(
      identityMigration.entrypoint,
    )
      ? identityMigration.entrypoint.join(" ")
      : String(identityMigration.entrypoint ?? "");
    if (
      identityMigrationEntrypoint !== "./node_modules/.bin/prisma" ||
      JSON.stringify(identityMigration.profiles ?? []) !==
        JSON.stringify(["identity-migration"]) ||
      identityMigration.network_mode !== "host" ||
      identityMigration.depends_on != null
    ) {
      throw new Error(
        "identity-migrate must use Prisma behind its isolated migration profile",
      );
    }
    const identityMigrationEnvironment = requireEnvironment(
      "identity-migrate",
      ["APP_REVISION", "NODE_ENV", "IDENTITY_DATABASE_URL"],
    );
    if (
      Object.keys(identityMigrationEnvironment).some(
        key =>
          ![
            "APP_REVISION",
            "NODE_ENV",
            "IDENTITY_DATABASE_URL",
          ].includes(key),
      )
    ) {
      throw new Error(
        "identity-migrate receives an unexpected environment",
      );
    }
    if (requireService("maintenance-worker").command != null) {
      throw new Error(
        "maintenance-worker command must be owned by its image",
      );
    }
    if (requireService("database-restore-worker").command != null) {
      throw new Error(
        "database-restore-worker command must be owned by its image",
      );
    }
    if (
      requireService("notification-delivery-worker").command != null
    ) {
      throw new Error(
        "notification-delivery-worker command must be owned by its image",
      );
    }
    if (requireService("campaigns-service").command != null) {
      throw new Error(
        "campaigns-service command must be owned by its image",
      );
    }
    if (requireService("reporting-service").command != null) {
      throw new Error(
        "reporting-service command must be owned by its image",
      );
    }
    if (requireService("widgets-service").command != null) {
      throw new Error(
        "widgets-service command must be owned by its image",
      );
    }

    requireEnvironment("api", [
      "RABBITMQ_MANAGEMENT_URL",
      "RABBITMQ_MONITOR_USER",
      "RABBITMQ_MONITOR_PASSWORD",
      "RABBITMQ_VHOST",
      "TRUST_PROXY",
      "JWT_ISSUER",
      "JWT_AUDIENCE",
      "CORS_ALLOWED_ORIGINS",
      "NOTIFICATION_DELIVERY_INTERNAL_URL",
      "NOTIFICATION_DELIVERY_INTERNAL_TOKEN",
      "NOTIFICATION_DELIVERY_INTERNAL_TIMEOUT_MS",
      "CAMPAIGNS_INTERNAL_TOKEN",
      "CAMPAIGNS_AUDIENCE_EXPORT_CHUNK_SIZE",
      "CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS",
        "REPORTING_INTERNAL_TOKEN",
        "WIDGETS_INTERNAL_BASE_URL",
        "WIDGETS_INTERNAL_TOKEN",
        "BILLING_INTERNAL_BASE_URL",
        "BILLING_INTERNAL_TOKEN",
        "BILLING_INTERNAL_TIMEOUT_MS",
        "IDENTITY_INTERNAL_BASE_URL",
        "IDENTITY_CORE_TOKEN",
        "CORE_IDENTITY_TOKEN",
        "IDENTITY_INTERNAL_TIMEOUT_MS",
        "DATABASE_RESTORE_STORAGE_DIR",
      "DATABASE_RESTORE_QUEUE_SECRET",
      "DATABASE_RESTORE_PRODUCTION_ENABLED",
    ]);
    const apiEnvironment = requireService("api").environment ?? {};
    for (const forbidden of [
      "JWT_ACCESS_PRIVATE_KEY_BASE64",
      "JWT_ACCESS_JWKS_BASE64",
      "JWT_ACCESS_ACTIVE_KID",
    ]) {
      if (forbidden in apiEnvironment) {
        throw new Error(
          `Core API must not receive retired Core signing material ${forbidden}`,
        );
      }
    }
    if (
      apiEnvironment.NOTIFICATION_DELIVERY_INTERNAL_URL !==
      "http://127.0.0.1:4401/internal/notification-delivery"
    ) {
      throw new Error(
        "api must use the exact loopback notification delivery endpoint",
      );
    }
    if (
      apiEnvironment.NOTIFICATION_DELIVERY_INTERNAL_TIMEOUT_MS !==
      "5000"
    ) {
      throw new Error(
        "api notification delivery timeout must default to 5000ms",
      );
    }
    if (
      apiEnvironment.BILLING_INTERNAL_BASE_URL !==
        "http://127.0.0.1:4800" ||
      apiEnvironment.BILLING_INTERNAL_TIMEOUT_MS !==
        process.env.BILLING_INTERNAL_TIMEOUT_MS
    ) {
      throw new Error(
        "Core API must use the exact loopback Billing internal endpoint and timeout",
      );
    }
    if (
      apiEnvironment.IDENTITY_INTERNAL_BASE_URL !==
        "http://127.0.0.1:4900" ||
      apiEnvironment.IDENTITY_INTERNAL_TIMEOUT_MS !== "5000"
    ) {
      throw new Error(
        "Core API must use the exact loopback Identity internal endpoint and timeout",
      );
    }
    if (
      apiEnvironment.DATABASE_RESTORE_STORAGE_DIR !==
        "/var/lib/winwidget/database-restores" ||
      apiEnvironment.DATABASE_RESTORE_QUEUE_SECRET !==
        process.env.DATABASE_RESTORE_QUEUE_SECRET ||
      apiEnvironment.DATABASE_RESTORE_PRODUCTION_ENABLED !==
        process.env.DATABASE_RESTORE_PRODUCTION_ENABLED ||
      apiEnvironment.DATABASE_RESTORE_PRODUCTION_ENABLED !== "false"
    ) {
      throw new Error(
        "api must receive the exact restore queue path, signing secret and disabled CI production gate",
      );
    }
    for (const [name, service] of Object.entries(services)) {
      if (
        name !== "api" &&
        "DATABASE_RESTORE_PRODUCTION_ENABLED" in
          (service.environment ?? {})
      ) {
        throw new Error(
          `${name} must not receive the API-only database restore production gate`,
        );
      }
    }
    const apiRestoreMounts = (requireService("api").volumes ?? [])
      .filter(
        mount =>
          mount.type === "bind" &&
          mount.target ===
            "/var/lib/winwidget/database-restores",
      );
    if (
      apiRestoreMounts.length !== 1 ||
      apiRestoreMounts[0].source !==
        process.env.DATABASE_RESTORE_STORAGE_DIR ||
      (requireService("api").secrets ?? []).length !== 0
    ) {
      throw new Error(
        "api restore queue mount or secret boundary is invalid",
      );
    }
    const gatewayEnvironment = requireEnvironment("api-gateway", [
      "GATEWAY_ROUTES_JSON",
      "CORS_ALLOWED_ORIGINS",
      "JWT_JWKS_URL",
      "JWT_ISSUER",
      "JWT_AUDIENCE",
      "JWT_CLOCK_TOLERANCE_SECONDS",
      "JWT_MAX_TOKEN_LIFETIME_SECONDS",
    ]);
    for (const forbidden of [
      "DATABASE_URL",
      "DATABASE_URL_PRODUCTION",
      "JWT_SECRET",
      "JWT_ACCESS_PRIVATE_KEY_BASE64",
      "JWT_ACCESS_JWKS_BASE64",
      "RABBITMQ_URL",
      "RABBITMQ_MONITOR_PASSWORD",
      "API_UPSTREAM_URL",
      "PROXY_TIMEOUT_MS",
    ]) {
      if (forbidden in gatewayEnvironment) {
        throw new Error(`api-gateway must not receive ${forbidden}`);
      }
    }
    const gatewayRoutes = JSON.parse(
      gatewayEnvironment.GATEWAY_ROUTES_JSON,
    );
    const expectedGatewayRoutes = [
      ...[
        ["identity-auth", "/api/v1/auth"],
        ["identity-users", "/api/v1/users"],
        ["identity-telegram-auth", "/api/v1/telegram-auth"],
        [
          "identity-info-webhook",
          "/api/v1/telegram-bot/webhook",
        ],
      ].map(([id, pathPrefix]) => ({
        id,
        pathPrefix,
        upstreamUrl: "http://127.0.0.1:4900",
        authPolicy: "optional",
        timeoutMs: 60000,
      })),
      {
        id: "billing-payments",
        pathPrefix: "/api/v1/payments",
        upstreamUrl: "http://127.0.0.1:4800",
        authPolicy: "optional",
        timeoutMs: 30000,
      },
      {
        id: "billing-subscriptions",
        pathPrefix: "/api/v1/subscriptions",
        upstreamUrl: "http://127.0.0.1:4800",
        authPolicy: "optional",
        timeoutMs: 30000,
      },
      {
        id: "billing-tariff-prices",
        pathPrefix: "/api/v1/tariff-prices",
        upstreamUrl: "http://127.0.0.1:4800",
        authPolicy: "optional",
        timeoutMs: 30000,
      },
      {
        id: "billing-affiliate",
        pathPrefix: "/api/v1/affiliate",
        upstreamUrl: "http://127.0.0.1:4800",
        authPolicy: "optional",
        timeoutMs: 30000,
      },
      {
        id: "database-restores",
        pathPrefix: "/api/v1/dev-tools/database-restores",
        upstreamUrl: "http://127.0.0.1:4200",
        authPolicy: "required",
        timeoutMs: 120000,
      },
      {
        id: "campaigns",
        pathPrefix: "/api/v1/admin/campaigns",
        upstreamUrl: "http://127.0.0.1:4500",
        authPolicy: "required",
        timeoutMs: 60000,
      },
      {
        id: "reporting",
        pathPrefix: "/api/v1/admin/reporting",
        upstreamUrl: "http://127.0.0.1:4600",
        authPolicy: "required",
        timeoutMs: 60000,
      },
      ...[
        ["widgets-admin", "/api/v1/widgets/admin", "required"],
        ["widgets-management", "/api/v1/widgets", "required"],
        ["quizzes-management", "/api/v1/quizzes", "required"],
        ["callbacks-management", "/api/v1/callbacks", "required"],
        ["countdown-timers-management", "/api/v1/countdown-timers", "required"],
        ["stop-offers-management", "/api/v1/stop-offers", "required"],
        ["online-consultants-management", "/api/v1/online-consultants", "required"],
        ["calculators-management", "/api/v1/calculators", "required"],
        ["widget-settings", "/api/v1/widget-settings", "required"],
        ["widget-runtime", "/api/v1/widget-runtime", "required"],
        ["widget-public", "/api/v1/widget", "optional"],
        ["quiz-public", "/api/v1/quiz", "optional"],
        ["callback-public", "/api/v1/callback", "optional"],
        ["countdown-timer-public", "/api/v1/countdown-timer", "optional"],
        ["stop-offer-public", "/api/v1/stop-offer", "optional"],
        ["online-consultant-public", "/api/v1/online-consultant", "optional"],
        ["calculator-public", "/api/v1/calculator", "optional"],
        ["widget-events", "/api/v1/widget-events", "optional"],
      ].map(([id, pathPrefix, authPolicy]) => ({
        id,
        pathPrefix,
        upstreamUrl: "http://127.0.0.1:4700",
        authPolicy,
        timeoutMs: 60000,
      })),
      {
        id: "monolith",
        pathPrefix: "/api/v1",
        upstreamUrl: "http://127.0.0.1:4200",
        authPolicy: "optional",
        timeoutMs: 60000,
      },
    ];
    if (
      JSON.stringify(gatewayRoutes) !==
      JSON.stringify(expectedGatewayRoutes)
    ) {
      throw new Error(
        "Production example must keep Billing, protected service, public Widgets and Reporting routes before the monolith catch-all",
      );
    }
    if (
      gatewayEnvironment.JWT_JWKS_URL !==
      "http://127.0.0.1:4900/api/v1/auth/.well-known/jwks.json"
    ) {
      throw new Error(
        "Production Gateway must verify JWTs against Identity JWKS",
      );
    }
    requireEnvironment("outbox-publisher", [
      "DATABASE_URL_PRODUCTION",
      "RABBITMQ_URL",
      "RABBITMQ_ASSERT_TOPOLOGY",
      "MESSAGING_SERVICE_NAME",
    ], ["DATABASE_URL_PRODUCTION"]);
    const integrationEnvironment = requireEnvironment(
      "integration-worker",
      [
        "DATABASE_URL_PRODUCTION",
        "RABBITMQ_URL",
        "RABBITMQ_ASSERT_TOPOLOGY",
        "MESSAGING_SERVICE_NAME",
        "INTEGRATION_WORKER_KINDS",
        "INTEGRATION_RECEIPT_RETENTION_DAYS",
        "INTEGRATION_FAILURE_DETAIL_RETENTION_DAYS",
      ],
      ["DATABASE_URL_PRODUCTION"],
    );
    const integrationKinds = integrationEnvironment.INTEGRATION_WORKER_KINDS
      .split(",")
      .map(value => value.trim())
      .filter(Boolean);
    const expectedIntegrationKinds = [
      "campaign-admin-audit",
      "reporting-admin-audit",
      "widgets-admin-audit",
      "billing-admin-audit",
      "identity-admin-audit",
      "billing-payment-projection",
      "billing-subscription-projection",
      "billing-affiliate-projection",
      "billing-settings-projection",
    ];
    if (
      JSON.stringify(integrationKinds) !==
      JSON.stringify(expectedIntegrationKinds)
    ) {
      throw new Error(
        "integration-worker kinds must match the steady Widgets ownership contract",
      );
    }
    if (
      integrationEnvironment.INTEGRATION_RECEIPT_RETENTION_DAYS !== "90" ||
      integrationEnvironment.INTEGRATION_FAILURE_DETAIL_RETENTION_DAYS !== "30"
    ) {
      throw new Error(
        "integration-worker retention defaults must remain receipt=90 and failure-detail=30 days",
      );
    }
    const notificationDelivery = requireService(
      "notification-delivery-worker",
    );
    const notificationDeliveryEnvironment = requireEnvironment(
      "notification-delivery-worker",
      [
        "APP_REVISION",
        "NOTIFICATION_DELIVERY_DATABASE_URL",
        "RABBITMQ_URL",
        "RABBITMQ_ASSERT_TOPOLOGY",
        "MESSAGING_SERVICE_NAME",
        "NOTIFICATION_DELIVERY_INTERNAL_TOKEN",
        "NOTIFICATION_DELIVERY_LISTEN_HOST",
        "NOTIFICATION_DELIVERY_HEALTH_PORT",
        "NOTIFICATION_DELIVERY_PREFETCH",
        "NOTIFICATION_DELIVERY_KINDS",
        "NOTIFICATION_DELIVERY_RECEIPT_RETENTION_DAYS",
        "NOTIFICATION_DELIVERY_FAILURE_DETAIL_RETENTION_DAYS",
        "SMTP_LOGIN",
        "SMTP_PASSWORD",
        "TELEGRAM_INFO_BOT_TOKEN",
      ],
      ["TELEGRAM_INFO_BOT_TOKEN"],
    );
    requireExactKinds(
      notificationDeliveryEnvironment,
      "NOTIFICATION_DELIVERY_KINDS",
      [
        "email",
        "telegram",
        "payment-email",
        "payment-telegram",
        "limit-email",
        "limit-telegram",
        "campaign-email",
        "campaign-telegram",
        "daily-summary-delivery-telegram",
        "subscription-expiry-email",
        "subscription-expiry-telegram",
      ],
      "notification-delivery-worker",
    );
    if (
      notificationDeliveryEnvironment.APP_REVISION !==
      process.env.NOTIFICATION_DELIVERY_REVISION
    ) {
      throw new Error(
        "notification-delivery-worker runtime revision is not pinned",
      );
    }
    if (
      notificationDeliveryEnvironment.NOTIFICATION_DELIVERY_RECEIPT_RETENTION_DAYS !== "90" ||
      notificationDeliveryEnvironment.NOTIFICATION_DELIVERY_FAILURE_DETAIL_RETENTION_DAYS !== "30"
    ) {
      throw new Error(
        "notification-delivery-worker retention defaults must remain receipt=90 and failure-detail=30 days",
      );
    }
    const campaigns = requireService("campaigns-service");
    const campaignsEnvironment = requireEnvironment(
      "campaigns-service",
      [
        "APP_REVISION",
        "CORS_ALLOWED_ORIGINS",
        "CAMPAIGNS_DATABASE_URL",
        "CAMPAIGNS_PROCESS_ROLE",
        "CAMPAIGNS_LISTEN_HOST",
        "CAMPAIGNS_HEALTH_PORT",
        "CAMPAIGNS_CORE_INTERNAL_BASE_URL",
        "CAMPAIGNS_INTERNAL_TOKEN",
        "CAMPAIGNS_INTERNAL_TIMEOUT_MS",
        "CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS",
        "CAMPAIGNS_AUDIENCE_IMPORT_BATCH_SIZE",
        "IDENTITY_INTERNAL_BASE_URL",
        "IDENTITY_CAMPAIGNS_TOKEN",
        "IDENTITY_INTERNAL_TIMEOUT_MS",
        "BILLING_INTERNAL_BASE_URL",
        "BILLING_CAMPAIGNS_TOKEN",
        "BILLING_INTERNAL_TIMEOUT_MS",
        "CAMPAIGNS_PREFETCH",
        "CAMPAIGNS_EMAIL_RATE_PER_SECOND",
        "CAMPAIGNS_TELEGRAM_RATE_PER_SECOND",
        "CAMPAIGNS_OUTBOX_BATCH_SIZE",
        "CAMPAIGNS_OUTBOX_POLL_INTERVAL_MS",
        "CAMPAIGNS_OUTBOX_RETENTION_DAYS",
        "RABBITMQ_URL",
        "RABBITMQ_ASSERT_TOPOLOGY",
        "MESSAGING_SERVICE_NAME",
      ],
    );
    if (
      campaignsEnvironment.APP_REVISION !==
        process.env.CAMPAIGNS_REVISION ||
      campaignsEnvironment.CAMPAIGNS_PROCESS_ROLE !== "all" ||
      campaignsEnvironment.CAMPAIGNS_LISTEN_HOST !== "127.0.0.1" ||
      campaignsEnvironment.CAMPAIGNS_HEALTH_PORT !== "4500" ||
      campaignsEnvironment.CAMPAIGNS_CORE_INTERNAL_BASE_URL !==
        "http://127.0.0.1:4200" ||
      campaignsEnvironment.IDENTITY_INTERNAL_BASE_URL !==
        "http://127.0.0.1:4900" ||
      campaignsEnvironment.IDENTITY_INTERNAL_TIMEOUT_MS !== "5000" ||
      campaignsEnvironment.BILLING_INTERNAL_BASE_URL !==
        "http://127.0.0.1:4800" ||
      campaignsEnvironment.BILLING_INTERNAL_TIMEOUT_MS !== "5000" ||
      campaigns.network_mode !== "host" ||
      !campaigns.healthcheck?.test
    ) {
      throw new Error(
        "Campaigns must use the reviewed loopback all-role runtime boundary",
      );
    }
    if (
      campaignsEnvironment.CORS_ALLOWED_ORIGINS !==
        gatewayEnvironment.CORS_ALLOWED_ORIGINS ||
      campaignsEnvironment.CORS_ALLOWED_ORIGINS !==
        apiEnvironment.CORS_ALLOWED_ORIGINS
    ) {
      throw new Error(
        "API, API Gateway and Campaigns must share one exact CORS origin policy",
      );
    }
    const reporting = requireService("reporting-service");
    const reportingEnvironment = requireEnvironment(
      "reporting-service",
      [
        "APP_REVISION",
        "CORS_ALLOWED_ORIGINS",
        "REPORTING_DATABASE_URL",
        "REPORTING_PROCESS_ROLE",
        "REPORTING_LISTEN_HOST",
        "REPORTING_PORT",
        "REPORTING_CORE_INTERNAL_BASE_URL",
        "REPORTING_INTERNAL_TOKEN",
        "REPORTING_INTERNAL_TIMEOUT_MS",
        "IDENTITY_INTERNAL_BASE_URL",
        "IDENTITY_REPORTING_TOKEN",
        "IDENTITY_INTERNAL_TIMEOUT_MS",
        "REPORTING_SCHEDULER_ENABLED",
        "REPORTING_PREFETCH",
        "REPORTING_OUTBOX_BATCH_SIZE",
        "REPORTING_OUTBOX_POLL_INTERVAL_MS",
        "REPORTING_OUTBOX_RETENTION_DAYS",
        "RABBITMQ_URL",
        "RABBITMQ_ASSERT_TOPOLOGY",
        "MESSAGING_SERVICE_NAME",
      ],
    );
    if (
      reportingEnvironment.APP_REVISION !==
        process.env.REPORTING_REVISION ||
      reportingEnvironment.REPORTING_PROCESS_ROLE !== "all" ||
      reportingEnvironment.REPORTING_LISTEN_HOST !== "127.0.0.1" ||
      reportingEnvironment.REPORTING_PORT !== "4600" ||
      reportingEnvironment.REPORTING_CORE_INTERNAL_BASE_URL !==
        "http://127.0.0.1:4200" ||
      reportingEnvironment.IDENTITY_INTERNAL_BASE_URL !==
        "http://127.0.0.1:4900" ||
      reportingEnvironment.IDENTITY_INTERNAL_TIMEOUT_MS !== "5000" ||
      reportingEnvironment.REPORTING_SCHEDULER_ENABLED !== "false" ||
      reporting.network_mode !== "host" ||
      !reporting.healthcheck?.test ||
      reporting.stop_grace_period !== "1m30s" ||
      reporting.restart !== "unless-stopped" ||
      Number(reporting.mem_limit) !== 536870912 ||
      Number(reporting.mem_reservation) !== 134217728 ||
      Number(reporting.cpus) !== 0.75 ||
      Number(reporting.pids_limit) !== 200 ||
      reporting.logging?.driver !== "json-file" ||
      reporting.logging?.options?.["max-size"] !== "10m" ||
      String(reporting.logging?.options?.["max-file"]) !== "3"
    ) {
      throw new Error(
        "Reporting must use the reviewed bounded loopback all-role dark runtime boundary",
      );
    }
    if (
      reportingEnvironment.CORS_ALLOWED_ORIGINS !==
        gatewayEnvironment.CORS_ALLOWED_ORIGINS ||
      reportingEnvironment.CORS_ALLOWED_ORIGINS !==
        apiEnvironment.CORS_ALLOWED_ORIGINS
    ) {
      throw new Error(
        "API, API Gateway and Reporting must share one exact CORS origin policy",
      );
    }
    const widgets = requireService("widgets-service");
    const widgetsEnvironment = requireEnvironment(
      "widgets-service",
      [
        "APP_REVISION",
        "CORS_ALLOWED_ORIGINS",
        "WIDGETS_DATABASE_URL",
        "WIDGETS_PROCESS_ROLE",
        "WIDGETS_LISTEN_HOST",
        "WIDGETS_PORT",
        "WIDGETS_CORE_INTERNAL_BASE_URL",
        "WIDGETS_INTERNAL_TOKEN",
        "WIDGETS_IDENTITY_TOKEN",
        "WIDGETS_INTERNAL_TIMEOUT_MS",
        "IDENTITY_INTERNAL_BASE_URL",
        "IDENTITY_WIDGETS_TOKEN",
        "IDENTITY_INTERNAL_TIMEOUT_MS",
        "WIDGETS_ENTITLEMENT_MAX_STALENESS_MS",
        "WIDGETS_PREFETCH",
        "WIDGETS_OUTBOX_BATCH_SIZE",
        "WIDGETS_OUTBOX_POLL_INTERVAL_MS",
        "WIDGETS_OUTBOX_RETENTION_DAYS",
        "WIDGETS_RECEIPT_RETENTION_DAYS",
        "WIDGETS_FAILURE_DETAIL_RETENTION_DAYS",
        "RABBITMQ_URL",
        "RABBITMQ_ASSERT_TOPOLOGY",
        "MESSAGING_SERVICE_NAME",
      ],
    );
    if (
      widgetsEnvironment.APP_REVISION !==
        process.env.WIDGETS_REVISION ||
      widgetsEnvironment.WIDGETS_PROCESS_ROLE !== "all" ||
      widgetsEnvironment.WIDGETS_LISTEN_HOST !== "127.0.0.1" ||
      widgetsEnvironment.WIDGETS_PORT !== "4700" ||
      widgetsEnvironment.WIDGETS_CORE_INTERNAL_BASE_URL !==
        "http://127.0.0.1:4200" ||
      widgetsEnvironment.IDENTITY_INTERNAL_BASE_URL !==
        "http://127.0.0.1:4900" ||
      widgetsEnvironment.IDENTITY_INTERNAL_TIMEOUT_MS !== "5000" ||
      widgetsEnvironment.WIDGETS_ENTITLEMENT_MAX_STALENESS_MS !==
        "31968000000" ||
      widgets.network_mode !== "host" ||
      !widgets.healthcheck?.test ||
      widgets.stop_grace_period !== "1m30s" ||
      widgets.restart !== "unless-stopped" ||
      Number(widgets.mem_limit) !== 536870912 ||
      Number(widgets.mem_reservation) !== 134217728 ||
      Number(widgets.cpus) !== 0.75 ||
      Number(widgets.pids_limit) !== 200 ||
      widgets.logging?.driver !== "json-file" ||
      widgets.logging?.options?.["max-size"] !== "10m" ||
      String(widgets.logging?.options?.["max-file"]) !== "3"
    ) {
      throw new Error(
        "Widgets must use the reviewed bounded loopback all-role runtime boundary",
      );
    }
    if (
      widgetsEnvironment.CORS_ALLOWED_ORIGINS !==
        gatewayEnvironment.CORS_ALLOWED_ORIGINS ||
      widgetsEnvironment.CORS_ALLOWED_ORIGINS !==
        apiEnvironment.CORS_ALLOWED_ORIGINS
    ) {
      throw new Error(
        "API, API Gateway and Widgets must share one exact CORS origin policy",
      );
    }
    const billingCommonEnvironmentKeys = [
      "APP_REVISION",
      "NODE_ENV",
      "MODE",
      "BILLING_DATABASE_URL",
      "BILLING_PROCESS_ROLE",
      "BILLING_LISTEN_HOST",
      "BILLING_API_PORT",
      "BILLING_SCHEDULER_PORT",
      "BILLING_WORKER_PORT",
      "BILLING_OUTBOX_PUBLISHER_PORT",
      "BILLING_PREFETCH",
      "BILLING_OUTBOX_BATCH_SIZE",
      "BILLING_OUTBOX_POLL_INTERVAL_MS",
      "BILLING_OUTBOX_RETENTION_DAYS",
      "BILLING_RECEIPT_RETENTION_DAYS",
      "BILLING_FAILURE_DETAIL_RETENTION_DAYS",
    ];
    const billingApi = requireService("billing-api");
    const billingScheduler = requireService("billing-scheduler");
    const billingWorker = requireService("billing-worker");
    const billingPublisher = requireService(
      "billing-outbox-publisher",
    );
    const billingApiEnvironment = requireEnvironment(
      "billing-api",
      [
        ...billingCommonEnvironmentKeys,
        "CORS_ALLOWED_ORIGINS",
        "TRUST_PROXY",
        "BILLING_CORE_INTERNAL_BASE_URL",
        "BILLING_INTERNAL_TOKEN",
        "BILLING_CAMPAIGNS_TOKEN",
        "BILLING_IDENTITY_TOKEN",
        "BILLING_INTERNAL_TIMEOUT_MS",
        "WIDGETS_INTERNAL_BASE_URL",
        "WIDGETS_INTERNAL_TOKEN",
        "WIDGETS_INTERNAL_TIMEOUT_MS",
        "IDENTITY_INTERNAL_BASE_URL",
        "IDENTITY_BILLING_TOKEN",
        "IDENTITY_INTERNAL_TIMEOUT_MS",
      ],
    );
    const billingSchedulerEnvironment = requireEnvironment(
      "billing-scheduler",
      billingCommonEnvironmentKeys,
    );
    const billingWorkerEnvironment = requireEnvironment(
      "billing-worker",
      [
        ...billingCommonEnvironmentKeys,
        "BILLING_CORE_INTERNAL_BASE_URL",
        "BILLING_INTERNAL_TOKEN",
        "BILLING_INTERNAL_TIMEOUT_MS",
        "IDENTITY_INTERNAL_BASE_URL",
        "IDENTITY_BILLING_TOKEN",
        "IDENTITY_INTERNAL_TIMEOUT_MS",
        "YOOKASSA_PRODUCTION_SHOP_ID",
        "YOOKASSA_PRODUCTION_SECRET_KEY",
        "PAYMENT_METHOD_ENCRYPTION_KEY",
        "RECAPTCHA_CLIENT_URL",
        "RABBITMQ_URL",
        "RABBITMQ_CONNECTION_NAME",
        "RABBITMQ_ASSERT_TOPOLOGY",
        "RABBITMQ_MAX_MESSAGE_BYTES",
        "MESSAGING_SERVICE_NAME",
      ],
    );
    const billingPublisherEnvironment = requireEnvironment(
      "billing-outbox-publisher",
      [
        ...billingCommonEnvironmentKeys,
        "RABBITMQ_URL",
        "RABBITMQ_CONNECTION_NAME",
        "RABBITMQ_ASSERT_TOPOLOGY",
        "RABBITMQ_MAX_MESSAGE_BYTES",
        "MESSAGING_SERVICE_NAME",
      ],
    );
    const billingRoles = new Map([
      ["billing-api", [billingApi, billingApiEnvironment, "api"]],
      [
        "billing-scheduler",
        [billingScheduler, billingSchedulerEnvironment, "scheduler"],
      ],
      [
        "billing-worker",
        [billingWorker, billingWorkerEnvironment, "worker"],
      ],
      [
        "billing-outbox-publisher",
        [billingPublisher, billingPublisherEnvironment, "outbox-publisher"],
      ],
    ]);
    const billingRuntimeLimits = {
      "billing-api": ["30s", 536870912, 134217728, 0.75],
      "billing-scheduler": ["1m30s", 402653184, 100663296, 0.5],
      "billing-worker": ["1m30s", 536870912, 134217728, 0.75],
      "billing-outbox-publisher": [
        "1m30s",
        402653184,
        100663296,
        0.5,
      ],
    };
    for (const [name, [service, environment, role]] of billingRoles) {
      const [stopGracePeriod, memLimit, memReservation, cpus] =
        billingRuntimeLimits[name];
      if (
        environment.APP_REVISION !== process.env.BILLING_REVISION ||
        environment.NODE_ENV !== "production" ||
        environment.MODE !== "production" ||
        environment.BILLING_PROCESS_ROLE !== role ||
        environment.BILLING_LISTEN_HOST !== "127.0.0.1" ||
        environment.BILLING_API_PORT !== "4800" ||
        environment.BILLING_SCHEDULER_PORT !== "4801" ||
        environment.BILLING_WORKER_PORT !== "4802" ||
        environment.BILLING_OUTBOX_PUBLISHER_PORT !== "4803" ||
        service.network_mode !== "host" ||
        !service.healthcheck?.test ||
        service.restart !== "unless-stopped" ||
        (service.profiles ?? []).length !== 0 ||
        service.stop_grace_period !== stopGracePeriod ||
        Number(service.mem_limit) !== memLimit ||
        Number(service.mem_reservation) !== memReservation ||
        Number(service.cpus) !== cpus ||
        Number(service.pids_limit) !== 200 ||
        service.logging?.driver !== "json-file" ||
        service.logging?.options?.["max-size"] !== "10m" ||
        String(service.logging?.options?.["max-file"]) !== "3"
      ) {
        throw new Error(
          `${name} must use the exact immutable loopback Billing role boundary`,
        );
      }
    }
    if (
      billingApiEnvironment.CORS_ALLOWED_ORIGINS !==
        gatewayEnvironment.CORS_ALLOWED_ORIGINS ||
      billingApiEnvironment.CORS_ALLOWED_ORIGINS !==
        apiEnvironment.CORS_ALLOWED_ORIGINS ||
      billingApiEnvironment.TRUST_PROXY !== "loopback" ||
      billingApiEnvironment.BILLING_CORE_INTERNAL_BASE_URL !==
        "http://127.0.0.1:4200" ||
      billingApiEnvironment.BILLING_INTERNAL_TIMEOUT_MS !==
        process.env.BILLING_INTERNAL_TIMEOUT_MS ||
      billingApiEnvironment.WIDGETS_INTERNAL_BASE_URL !==
        "http://127.0.0.1:4700" ||
      billingApiEnvironment.WIDGETS_INTERNAL_TIMEOUT_MS !== "5000" ||
      billingApiEnvironment.IDENTITY_INTERNAL_BASE_URL !==
        "http://127.0.0.1:4900" ||
      billingApiEnvironment.IDENTITY_INTERNAL_TIMEOUT_MS !== "5000" ||
      billingWorkerEnvironment.BILLING_CORE_INTERNAL_BASE_URL !==
        "http://127.0.0.1:4200" ||
      billingWorkerEnvironment.BILLING_INTERNAL_TIMEOUT_MS !==
        process.env.BILLING_INTERNAL_TIMEOUT_MS ||
      billingWorkerEnvironment.IDENTITY_INTERNAL_BASE_URL !==
        "http://127.0.0.1:4900" ||
      billingWorkerEnvironment.IDENTITY_INTERNAL_TIMEOUT_MS !== "5000"
    ) {
      throw new Error(
        "Billing API/worker internal HTTP, proxy or CORS contract drifted",
      );
    }
    const identityCommonEnvironmentKeys = [
      "APP_REVISION",
      "NODE_ENV",
      "MODE",
      "IDENTITY_DATABASE_URL",
      "IDENTITY_PROCESS_ROLE",
      "IDENTITY_LISTEN_HOST",
      "IDENTITY_PORT",
      "IDENTITY_API_PORT",
      "IDENTITY_WORKER_PORT",
      "IDENTITY_OUTBOX_PUBLISHER_PORT",
      "IDENTITY_PREFETCH",
      "IDENTITY_OUTBOX_BATCH_SIZE",
      "IDENTITY_OUTBOX_POLL_INTERVAL_MS",
      "IDENTITY_OUTBOX_RETENTION_DAYS",
      "IDENTITY_RECEIPT_RETENTION_DAYS",
      "IDENTITY_FAILURE_DETAIL_RETENTION_DAYS",
    ];
    const identityApi = requireService("identity-api");
    const identityWorker = requireService("identity-worker");
    const identityPublisher = requireService(
      "identity-outbox-publisher",
    );
    const identityApiEnvironment = requireEnvironment(
      "identity-api",
      [
        ...identityCommonEnvironmentKeys,
        "CORS_ALLOWED_ORIGINS",
        "TRUST_PROXY",
        "JWT_ACCESS_PRIVATE_KEY_BASE64",
        "JWT_ACCESS_JWKS_BASE64",
        "JWT_ACCESS_ACTIVE_KID",
        "JWT_ISSUER",
        "JWT_AUDIENCE",
        "TELEGRAM_WEBHOOK_HOST",
        "TELEGRAM_INFO_BOT_TOKEN",
        "TELEGRAM_INFO_BOT_USERNAME",
        "TELEGRAM_INFO_BOT_WEBHOOK_SECRET",
        "IDENTITY_CORE_TOKEN",
        "CORE_IDENTITY_TOKEN",
        "IDENTITY_CAMPAIGNS_TOKEN",
        "IDENTITY_REPORTING_TOKEN",
        "IDENTITY_WIDGETS_TOKEN",
        "IDENTITY_BILLING_TOKEN",
        "IDENTITY_INTERNAL_TIMEOUT_MS",
        "BILLING_INTERNAL_BASE_URL",
        "BILLING_IDENTITY_TOKEN",
        "BILLING_INTERNAL_TIMEOUT_MS",
        "WIDGETS_INTERNAL_BASE_URL",
        "WIDGETS_IDENTITY_TOKEN",
        "WIDGETS_INTERNAL_TIMEOUT_MS",
        "IDENTITY_AVATAR_S3_ENDPOINT",
        "IDENTITY_AVATAR_S3_REGION",
        "IDENTITY_AVATAR_S3_BUCKET",
        "IDENTITY_AVATAR_S3_ACCESS_KEY_ID",
        "IDENTITY_AVATAR_S3_SECRET_ACCESS_KEY",
        "IDENTITY_AVATAR_S3_PUBLIC_BASE_URL",
        "IDENTITY_AVATAR_S3_FORCE_PATH_STYLE",
      ],
    );
    const identityWorkerEnvironment = requireEnvironment(
      "identity-worker",
      [
        ...identityCommonEnvironmentKeys,
        "RABBITMQ_URL",
        "RABBITMQ_CONNECTION_NAME",
        "RABBITMQ_ASSERT_TOPOLOGY",
        "RABBITMQ_MAX_MESSAGE_BYTES",
        "MESSAGING_SERVICE_NAME",
      ],
    );
    const identityPublisherEnvironment = requireEnvironment(
      "identity-outbox-publisher",
      [
        ...identityCommonEnvironmentKeys,
        "RABBITMQ_URL",
        "RABBITMQ_CONNECTION_NAME",
        "RABBITMQ_ASSERT_TOPOLOGY",
        "RABBITMQ_MAX_MESSAGE_BYTES",
        "MESSAGING_SERVICE_NAME",
      ],
    );
    if (
      "TELEGRAM_INFO_BOT_WEBHOOK_SECRET" in apiEnvironment ||
      !("TELEGRAM_INFO_BOT_TOKEN" in apiEnvironment) ||
      !("TELEGRAM_INFO_BOT_USERNAME" in apiEnvironment)
    ) {
      throw new Error(
        "Info_bot webhook secret must be Identity-only while Core retains only outbound token/username",
      );
    }
    const identityRoles = new Map([
      [
        "identity-api",
        [identityApi, identityApiEnvironment, "api", "4900"],
      ],
      [
        "identity-worker",
        [identityWorker, identityWorkerEnvironment, "worker", "4901"],
      ],
      [
        "identity-outbox-publisher",
        [
          identityPublisher,
          identityPublisherEnvironment,
          "outbox-publisher",
          "4902",
        ],
      ],
    ]);
    const identityRuntimeLimits = {
      "identity-api": ["30s", 536870912, 134217728, 0.75],
      "identity-worker": ["1m30s", 536870912, 134217728, 0.75],
      "identity-outbox-publisher": [
        "1m30s",
        402653184,
        100663296,
        0.5,
      ],
    };
    for (const [
      name,
      [service, environment, role, port],
    ] of identityRoles) {
      const [stopGracePeriod, memLimit, memReservation, cpus] =
        identityRuntimeLimits[name];
      if (
        environment.APP_REVISION !== process.env.IDENTITY_REVISION ||
        environment.NODE_ENV !== "production" ||
        environment.MODE !== "production" ||
        environment.IDENTITY_PROCESS_ROLE !== role ||
        environment.IDENTITY_LISTEN_HOST !== "127.0.0.1" ||
        environment.IDENTITY_PORT !== port ||
        environment.IDENTITY_API_PORT !== "4900" ||
        environment.IDENTITY_WORKER_PORT !== "4901" ||
        environment.IDENTITY_OUTBOX_PUBLISHER_PORT !== "4902" ||
        service.network_mode !== "host" ||
        !service.healthcheck?.test ||
        service.restart !== "unless-stopped" ||
        (service.profiles ?? []).length !== 0 ||
        service.stop_grace_period !== stopGracePeriod ||
        Number(service.mem_limit) !== memLimit ||
        Number(service.mem_reservation) !== memReservation ||
        Number(service.cpus) !== cpus ||
        Number(service.pids_limit) !== 200 ||
        service.logging?.driver !== "json-file" ||
        service.logging?.options?.["max-size"] !== "10m" ||
        String(service.logging?.options?.["max-file"]) !== "3"
      ) {
        throw new Error(
          `${name} must use the exact immutable loopback Identity role boundary`,
        );
      }
    }
    if (
      identityApiEnvironment.CORS_ALLOWED_ORIGINS !==
        gatewayEnvironment.CORS_ALLOWED_ORIGINS ||
      identityApiEnvironment.CORS_ALLOWED_ORIGINS !==
        apiEnvironment.CORS_ALLOWED_ORIGINS ||
      identityApiEnvironment.TRUST_PROXY !== "loopback" ||
      identityApiEnvironment.IDENTITY_INTERNAL_TIMEOUT_MS !== "5000" ||
      identityApiEnvironment.BILLING_INTERNAL_BASE_URL !==
        "http://127.0.0.1:4800" ||
      identityApiEnvironment.WIDGETS_INTERNAL_BASE_URL !==
        "http://127.0.0.1:4700" ||
      identityApiEnvironment.JWT_ACCESS_PRIVATE_KEY_BASE64 ===
        process.env.JWT_ACCESS_PRIVATE_KEY_BASE64 ||
      identityApiEnvironment.JWT_ACCESS_JWKS_BASE64 ===
        process.env.JWT_ACCESS_JWKS_BASE64 ||
      identityApiEnvironment.JWT_ACCESS_ACTIVE_KID ===
        process.env.JWT_ACCESS_ACTIVE_KID ||
      "BILLING_INTERNAL_TOKEN" in identityApiEnvironment ||
      "WIDGETS_INTERNAL_TOKEN" in identityApiEnvironment ||
      identityApi.labels?.["com.winwidget.singleton"] !== "true" ||
      identityApi.depends_on != null ||
      JSON.stringify(Object.keys(identityWorker.depends_on ?? {})) !==
        JSON.stringify(["rabbitmq"]) ||
      JSON.stringify(Object.keys(identityPublisher.depends_on ?? {})) !==
        JSON.stringify(["rabbitmq"]) ||
      identityWorkerEnvironment.RABBITMQ_CONNECTION_NAME !==
        "winwidget-identity-worker" ||
      identityWorkerEnvironment.RABBITMQ_ASSERT_TOPOLOGY !== "true" ||
      identityWorkerEnvironment.MESSAGING_SERVICE_NAME !==
        "identity-worker" ||
      identityPublisherEnvironment.RABBITMQ_CONNECTION_NAME !==
        "winwidget-identity-outbox-publisher" ||
      identityPublisherEnvironment.RABBITMQ_ASSERT_TOPOLOGY !==
        "false" ||
      identityPublisherEnvironment.MESSAGING_SERVICE_NAME !==
        "identity-outbox-publisher"
    ) {
      throw new Error(
        "Identity API singleton, internal clients or RabbitMQ role boundary drifted",
      );
    }
    const providerSecretEnvironmentKeys = [
      "YOOKASSA_PRODUCTION_SHOP_ID",
      "YOOKASSA_PRODUCTION_SECRET_KEY",
      "PAYMENT_METHOD_ENCRYPTION_KEY",
    ];
    const providerEnvironmentKeys = [
      ...providerSecretEnvironmentKeys,
      "RECAPTCHA_CLIENT_URL",
    ];
    for (const [name, environment] of [
      ["api", apiEnvironment],
      ["integration-worker", integrationEnvironment],
    ]) {
      for (const key of providerSecretEnvironmentKeys) {
        if (key in environment) {
          throw new Error(
            `${name} must not receive Billing provider secret ${key}`,
          );
        }
      }
    }
    const forbiddenDevelopmentProviderKeys = [
      "YOOKASSA_SHOP_ID",
      "YOOKASSA_SECRET_KEY",
    ];
    const coreCallerEnvironmentKeys = [
      "BILLING_CORE_INTERNAL_BASE_URL",
      "BILLING_INTERNAL_TOKEN",
      "BILLING_INTERNAL_TIMEOUT_MS",
    ];
    const widgetsCallerEnvironmentKeys = [
      "WIDGETS_INTERNAL_BASE_URL",
      "WIDGETS_INTERNAL_TOKEN",
      "WIDGETS_INTERNAL_TIMEOUT_MS",
    ];
    for (const [name, [, environment]] of billingRoles) {
      const mustNotReceive = [
        ...forbiddenDevelopmentProviderKeys,
        ...(name === "billing-worker" ? [] : providerEnvironmentKeys),
        ...(name === "billing-api" || name === "billing-worker"
          ? []
          : coreCallerEnvironmentKeys),
        ...(name === "billing-api" ? [] : widgetsCallerEnvironmentKeys),
        ...(name === "billing-api" ? [] : ["TRUST_PROXY"]),
        ...(name === "billing-api" ? [] : ["CORS_ALLOWED_ORIGINS"]),
      ];
      for (const key of mustNotReceive) {
        if (key in environment) {
          throw new Error(`${name} must not receive ${key}`);
        }
      }
      const rabbitExpected =
        name === "billing-worker" ||
        name === "billing-outbox-publisher";
      if (("RABBITMQ_URL" in environment) !== rabbitExpected) {
        throw new Error(`${name} RabbitMQ credential scope drifted`);
      }
    }
    if (
      billingApi.depends_on != null ||
      billingScheduler.depends_on != null ||
      JSON.stringify(Object.keys(billingWorker.depends_on ?? {})) !==
        JSON.stringify(["rabbitmq"]) ||
      JSON.stringify(Object.keys(billingPublisher.depends_on ?? {})) !==
        JSON.stringify(["rabbitmq"]) ||
      billingWorkerEnvironment.RABBITMQ_CONNECTION_NAME !==
        "winwidget-billing-worker" ||
      billingWorkerEnvironment.RABBITMQ_ASSERT_TOPOLOGY !== "true" ||
      billingWorkerEnvironment.MESSAGING_SERVICE_NAME !==
        "billing-worker" ||
      billingPublisherEnvironment.RABBITMQ_CONNECTION_NAME !==
        "winwidget-billing-outbox-publisher" ||
      billingPublisherEnvironment.RABBITMQ_ASSERT_TOPOLOGY !== "false" ||
      billingPublisherEnvironment.MESSAGING_SERVICE_NAME !==
        "billing-outbox-publisher"
    ) {
      throw new Error(
        "Billing role dependency, topology ownership or connection identity drifted",
      );
    }
    const internalTokens = [
      apiEnvironment.NOTIFICATION_DELIVERY_INTERNAL_TOKEN,
      notificationDeliveryEnvironment.NOTIFICATION_DELIVERY_INTERNAL_TOKEN,
    ];
    if (
      internalTokens.some(
        token =>
          typeof token !== "string" ||
          token === "XYZXYZXYZ" ||
          token.startsWith("change_me") ||
          token.length < 32,
      ) ||
      internalTokens[0] !== internalTokens[1]
    ) {
      throw new Error(
        "api and notification-delivery-worker must share one non-placeholder internal token of at least 32 characters",
      );
    }
    const campaignsInternalTokens = [
      apiEnvironment.CAMPAIGNS_INTERNAL_TOKEN,
      campaignsEnvironment.CAMPAIGNS_INTERNAL_TOKEN,
    ];
    if (
      campaignsInternalTokens.some(
        token =>
          typeof token !== "string" ||
          token.startsWith("change_me") ||
          token.length < 32,
      ) ||
      campaignsInternalTokens[0] !== campaignsInternalTokens[1]
    ) {
      throw new Error(
        "Core and Campaigns must share one non-placeholder internal token",
      );
    }
    const reportingInternalTokens = [
      apiEnvironment.REPORTING_INTERNAL_TOKEN,
      reportingEnvironment.REPORTING_INTERNAL_TOKEN,
    ];
    if (
      reportingInternalTokens.some(
        token =>
          typeof token !== "string" ||
          token.startsWith("change_me") ||
          token.length < 32,
      ) ||
      reportingInternalTokens[0] !== reportingInternalTokens[1]
    ) {
      throw new Error(
        "Core and Reporting must share one non-placeholder internal token",
      );
    }
    const widgetsInternalTokens = [
      apiEnvironment.WIDGETS_INTERNAL_TOKEN,
      widgetsEnvironment.WIDGETS_INTERNAL_TOKEN,
      billingApiEnvironment.WIDGETS_INTERNAL_TOKEN,
    ];
    if (
      widgetsInternalTokens.some(
        token =>
          typeof token !== "string" ||
          token.startsWith("change_me") ||
          token.length < 32,
      ) ||
      widgetsInternalTokens[0] !== widgetsInternalTokens[1] ||
      apiEnvironment.WIDGETS_INTERNAL_BASE_URL !==
        "http://127.0.0.1:4700"
    ) {
      throw new Error(
        "Core, Widgets and Billing API must share one non-placeholder Widgets token and loopback origin",
      );
    }
    const billingInternalTokens = [
      apiEnvironment.BILLING_INTERNAL_TOKEN,
      billingApiEnvironment.BILLING_INTERNAL_TOKEN,
      billingWorkerEnvironment.BILLING_INTERNAL_TOKEN,
    ];
    if (
      billingInternalTokens.some(
        token =>
          typeof token !== "string" ||
          token.startsWith("change_me") ||
          token.length < 32,
      ) ||
      new Set(billingInternalTokens).size !== 1
    ) {
      throw new Error(
        "Core, Billing API and Billing worker must share one non-placeholder internal token",
      );
    }
    const requireMutualToken = (name, values) => {
      if (
        values.some(
          token =>
            typeof token !== "string" ||
            token.startsWith("change_me") ||
            token.length < 32,
        ) ||
        new Set(values).size !== 1
      ) {
        throw new Error(
          `${name} callers must share one non-placeholder token of at least 32 characters`,
        );
      }
    };
    requireMutualToken("Core to Identity", [
      apiEnvironment.IDENTITY_CORE_TOKEN,
      requireService("identity-api").environment?.IDENTITY_CORE_TOKEN,
    ]);
    requireMutualToken("Identity to Core", [
      apiEnvironment.CORE_IDENTITY_TOKEN,
      requireService("identity-api").environment?.CORE_IDENTITY_TOKEN,
    ]);
    requireMutualToken("Campaigns to Identity", [
      campaignsEnvironment.IDENTITY_CAMPAIGNS_TOKEN,
      requireService("identity-api").environment
        ?.IDENTITY_CAMPAIGNS_TOKEN,
    ]);
    requireMutualToken("Reporting to Identity", [
      reportingEnvironment.IDENTITY_REPORTING_TOKEN,
      requireService("identity-api").environment
        ?.IDENTITY_REPORTING_TOKEN,
    ]);
    requireMutualToken("Widgets to Identity", [
      widgetsEnvironment.IDENTITY_WIDGETS_TOKEN,
      requireService("identity-api").environment
        ?.IDENTITY_WIDGETS_TOKEN,
    ]);
    requireMutualToken("Billing to Identity", [
      billingApiEnvironment.IDENTITY_BILLING_TOKEN,
      billingWorkerEnvironment.IDENTITY_BILLING_TOKEN,
      requireService("identity-api").environment
        ?.IDENTITY_BILLING_TOKEN,
    ]);
    requireMutualToken("Campaigns to Billing", [
      campaignsEnvironment.BILLING_CAMPAIGNS_TOKEN,
      billingApiEnvironment.BILLING_CAMPAIGNS_TOKEN,
    ]);
    requireMutualToken("Identity to Billing", [
      identityApiEnvironment.BILLING_IDENTITY_TOKEN,
      billingApiEnvironment.BILLING_IDENTITY_TOKEN,
    ]);
    requireMutualToken("Identity to Widgets", [
      identityApiEnvironment.WIDGETS_IDENTITY_TOKEN,
      widgetsEnvironment.WIDGETS_IDENTITY_TOKEN,
    ]);
    const isolatedCallerTokens = [
      apiEnvironment.IDENTITY_CORE_TOKEN,
      apiEnvironment.CORE_IDENTITY_TOKEN,
      campaignsEnvironment.IDENTITY_CAMPAIGNS_TOKEN,
      reportingEnvironment.IDENTITY_REPORTING_TOKEN,
      widgetsEnvironment.IDENTITY_WIDGETS_TOKEN,
      billingApiEnvironment.IDENTITY_BILLING_TOKEN,
      campaignsEnvironment.BILLING_CAMPAIGNS_TOKEN,
      identityApiEnvironment.BILLING_IDENTITY_TOKEN,
      identityApiEnvironment.WIDGETS_IDENTITY_TOKEN,
    ];
    if (new Set(isolatedCallerTokens).size !== isolatedCallerTokens.length) {
      throw new Error(
        "Identity cross-domain credentials must remain audience-scoped and distinct",
      );
    }
    const maintenance = requireService("maintenance-worker");
    const maintenanceEnvironment = requireEnvironment(
      "maintenance-worker",
      [
        "DATABASE_URL_PRODUCTION",
        "RABBITMQ_URL",
        "RABBITMQ_ASSERT_TOPOLOGY",
        "MESSAGING_SERVICE_NAME",
        "DATABASE_BACKUP_URL",
        "NOTIFICATION_DELIVERY_BACKUP_URL",
        "CAMPAIGNS_BACKUP_URL",
        "REPORTING_BACKUP_URL",
        "WIDGETS_BACKUP_URL",
        "BILLING_BACKUP_URL",
        "IDENTITY_BACKUP_URL",
        "MAINTENANCE_WORKER_PREFETCH",
        "MAINTENANCE_HEALTH_PORT",
        "SCHEDULED_JOB_POLL_INTERVAL_MS",
        "SCHEDULED_JOB_LEASE_MS",
        "SCHEDULED_JOB_LEASE_RENEW_INTERVAL_MS",
        "MAINTENANCE_WORKER_KINDS",
      ],
      [],
    );
    requireExactKinds(
      maintenanceEnvironment,
      "MAINTENANCE_WORKER_KINDS",
      ["database-backup"],
      "maintenance-worker",
    );
    const databaseRestoreWorker = requireService(
      "database-restore-worker",
    );
    const databaseRestoreEnvironment = requireEnvironment(
      "database-restore-worker",
      [
        "APP_REVISION",
        "NODE_ENV",
        "DATABASE_RESTORE_STORAGE_DIR",
        "DATABASE_RESTORE_QUEUE_SECRET",
        "DATABASE_RESTORE_POLL_INTERVAL_MS",
        "DATABASE_RESTORE_COMMAND_TIMEOUT_MS",
        "DATABASE_RESTORE_MIGRATIONS_ROOT",
        "DATABASE_RESTORE_CORE_PORT",
        "DATABASE_RESTORE_NOTIFICATION_DELIVERY_PORT",
        "DATABASE_RESTORE_CAMPAIGNS_PORT",
        "DATABASE_RESTORE_REPORTING_PORT",
        "DATABASE_RESTORE_WIDGETS_PORT",
        "DATABASE_RESTORE_BILLING_PORT",
        "DATABASE_RESTORE_IDENTITY_PORT",
        "DATABASE_RESTORE_CORE_ADMIN_PASSWORD_FILE",
        "DATABASE_RESTORE_NOTIFICATION_DELIVERY_ADMIN_PASSWORD_FILE",
        "DATABASE_RESTORE_CAMPAIGNS_ADMIN_PASSWORD_FILE",
        "DATABASE_RESTORE_REPORTING_ADMIN_PASSWORD_FILE",
        "DATABASE_RESTORE_WIDGETS_ADMIN_PASSWORD_FILE",
        "DATABASE_RESTORE_BILLING_ADMIN_PASSWORD_FILE",
        "DATABASE_RESTORE_IDENTITY_ADMIN_PASSWORD_FILE",
      ],
    );
    const expectedDatabaseRestoreEnvironmentKeys = [
      "APP_REVISION",
      "DATABASE_RESTORE_BILLING_ADMIN_PASSWORD_FILE",
      "DATABASE_RESTORE_BILLING_PORT",
      "DATABASE_RESTORE_CAMPAIGNS_ADMIN_PASSWORD_FILE",
      "DATABASE_RESTORE_CAMPAIGNS_PORT",
      "DATABASE_RESTORE_COMMAND_TIMEOUT_MS",
      "DATABASE_RESTORE_CORE_ADMIN_PASSWORD_FILE",
      "DATABASE_RESTORE_CORE_PORT",
      "DATABASE_RESTORE_IDENTITY_ADMIN_PASSWORD_FILE",
      "DATABASE_RESTORE_IDENTITY_PORT",
      "DATABASE_RESTORE_MIGRATIONS_ROOT",
      "DATABASE_RESTORE_NOTIFICATION_DELIVERY_ADMIN_PASSWORD_FILE",
      "DATABASE_RESTORE_NOTIFICATION_DELIVERY_PORT",
      "DATABASE_RESTORE_POLL_INTERVAL_MS",
      "DATABASE_RESTORE_QUEUE_SECRET",
      "DATABASE_RESTORE_REPORTING_ADMIN_PASSWORD_FILE",
      "DATABASE_RESTORE_REPORTING_PORT",
      "DATABASE_RESTORE_WIDGETS_ADMIN_PASSWORD_FILE",
      "DATABASE_RESTORE_WIDGETS_PORT",
      "DATABASE_RESTORE_STORAGE_DIR",
      "NODE_ENV",
    ].sort();
    if (
      JSON.stringify(Object.keys(databaseRestoreEnvironment).sort()) !==
        JSON.stringify(expectedDatabaseRestoreEnvironmentKeys) ||
      databaseRestoreEnvironment.APP_REVISION !==
        process.env.DATABASE_RESTORE_REVISION ||
      databaseRestoreEnvironment.NODE_ENV !== "production" ||
      databaseRestoreEnvironment.DATABASE_RESTORE_STORAGE_DIR !==
        "/var/lib/winwidget/database-restores" ||
      databaseRestoreEnvironment.DATABASE_RESTORE_QUEUE_SECRET !==
        apiEnvironment.DATABASE_RESTORE_QUEUE_SECRET ||
      databaseRestoreEnvironment.DATABASE_RESTORE_POLL_INTERVAL_MS !==
        "1000" ||
      databaseRestoreEnvironment.DATABASE_RESTORE_COMMAND_TIMEOUT_MS !==
        "1800000" ||
      databaseRestoreEnvironment.DATABASE_RESTORE_MIGRATIONS_ROOT !==
        "/app" ||
      databaseRestoreEnvironment.DATABASE_RESTORE_CORE_PORT !==
        "55434" ||
      databaseRestoreEnvironment.DATABASE_RESTORE_NOTIFICATION_DELIVERY_PORT !==
        process.env.NOTIFICATION_DELIVERY_POSTGRES_PORT ||
      databaseRestoreEnvironment.DATABASE_RESTORE_CAMPAIGNS_PORT !==
        process.env.CAMPAIGNS_POSTGRES_PORT ||
      databaseRestoreEnvironment.DATABASE_RESTORE_REPORTING_PORT !==
        process.env.REPORTING_POSTGRES_PORT ||
      databaseRestoreEnvironment.DATABASE_RESTORE_WIDGETS_PORT !==
        process.env.WIDGETS_POSTGRES_PORT ||
      databaseRestoreEnvironment.DATABASE_RESTORE_BILLING_PORT !==
        process.env.BILLING_POSTGRES_PORT ||
      databaseRestoreEnvironment.DATABASE_RESTORE_IDENTITY_PORT !==
        process.env.IDENTITY_POSTGRES_PORT ||
      databaseRestoreEnvironment.DATABASE_RESTORE_CORE_ADMIN_PASSWORD_FILE !==
        "/run/database-restore-secrets/core-admin-password" ||
      databaseRestoreEnvironment.DATABASE_RESTORE_NOTIFICATION_DELIVERY_ADMIN_PASSWORD_FILE !==
        "/run/database-restore-secrets/notification-delivery-admin-password" ||
      databaseRestoreEnvironment.DATABASE_RESTORE_CAMPAIGNS_ADMIN_PASSWORD_FILE !==
        "/run/database-restore-secrets/campaigns-admin-password" ||
      databaseRestoreEnvironment.DATABASE_RESTORE_REPORTING_ADMIN_PASSWORD_FILE !==
        "/run/database-restore-secrets/reporting-admin-password" ||
      databaseRestoreEnvironment.DATABASE_RESTORE_WIDGETS_ADMIN_PASSWORD_FILE !==
        "/run/database-restore-secrets/widgets-admin-password" ||
      databaseRestoreEnvironment.DATABASE_RESTORE_BILLING_ADMIN_PASSWORD_FILE !==
        "/run/database-restore-secrets/billing-admin-password" ||
      databaseRestoreEnvironment.DATABASE_RESTORE_IDENTITY_ADMIN_PASSWORD_FILE !==
        "/run/database-restore-secrets/identity-admin-password"
    ) {
      throw new Error(
        "database-restore-worker environment or credential boundary drifted",
      );
    }
    const databaseRestoreMounts =
      databaseRestoreWorker.volumes ?? [];
    const databaseRestoreSecrets = [
      ...(databaseRestoreWorker.secrets ?? []),
    ].sort((left, right) =>
      String(left.source).localeCompare(String(right.source)),
    );
    const databaseRestoreHealthcheck = JSON.stringify(
      databaseRestoreWorker.healthcheck?.test ?? [],
    );
    const databaseRestoreHealthcheckCommand =
      databaseRestoreWorker.healthcheck?.test ?? [];
    const expectedDatabaseRestoreSecrets = [
      [
        "billing-postgres-admin-password",
        "database-restore-billing-admin-password",
      ],
      [
        "campaigns-postgres-admin-password",
        "database-restore-campaigns-admin-password",
      ],
      [
        "core-postgres-admin-password",
        "database-restore-core-admin-password",
      ],
      [
        "identity-postgres-admin-password",
        "database-restore-identity-admin-password",
      ],
      [
        "notification-delivery-postgres-admin-password",
        "database-restore-notification-delivery-admin-password",
      ],
      [
        "reporting-postgres-admin-password",
        "database-restore-reporting-admin-password",
      ],
      [
        "widgets-postgres-admin-password",
        "database-restore-widgets-admin-password",
      ],
    ];
    if (
      databaseRestoreMounts.length !== 1 ||
      databaseRestoreMounts[0].type !== "bind" ||
      databaseRestoreMounts[0].source !==
        process.env.DATABASE_RESTORE_STORAGE_DIR ||
      databaseRestoreMounts[0].target !==
        "/var/lib/winwidget/database-restores" ||
      JSON.stringify(
        databaseRestoreSecrets.map(secret => [
          secret.source,
          secret.target,
        ]),
      ) !== JSON.stringify(expectedDatabaseRestoreSecrets) ||
      databaseRestoreWorker.network_mode !== "host" ||
      databaseRestoreWorker.depends_on != null ||
      databaseRestoreWorker.read_only !== true ||
      databaseRestoreWorker.init !== true ||
      databaseRestoreWorker.restart !== "unless-stopped" ||
      databaseRestoreWorker.stop_grace_period !== "45s" ||
      Number(databaseRestoreWorker.mem_limit) !== 268435456 ||
      Number(databaseRestoreWorker.mem_reservation) !== 67108864 ||
      Number(databaseRestoreWorker.cpus) !== 0.5 ||
      Number(databaseRestoreWorker.pids_limit) !== 100 ||
      JSON.stringify(databaseRestoreHealthcheckCommand.slice(0, 4)) !==
        JSON.stringify(["CMD", "su-exec", "nestjs:nodejs", "node"]) ||
      !String(databaseRestoreHealthcheckCommand.at(-1)).includes(
        JSON.stringify([
          "billing",
          "campaigns",
          "core",
          "identity",
          "notification-delivery",
          "reporting",
          "widgets",
        ]),
      ) ||
      !databaseRestoreHealthcheck.includes("/fences") ||
      !databaseRestoreHealthcheck.includes("fences.length!==0") ||
      databaseRestoreWorker.labels?.["com.winwidget.owner"] !==
        "maintenance" ||
      databaseRestoreWorker.labels?.["com.winwidget.purpose"] !==
        "database-restore-worker"
    ) {
      throw new Error(
        "database-restore-worker runtime isolation drifted",
      );
    }
    const restoreTmpfs = Array.isArray(databaseRestoreWorker.tmpfs)
      ? databaseRestoreWorker.tmpfs.map(value =>
          typeof value === "string" ? value : JSON.stringify(value),
        )
      : [];
    if (
      !restoreTmpfs.some(value =>
        value.startsWith("/run/database-restore-secrets"),
      ) ||
      !restoreTmpfs.some(value => value.startsWith("/tmp")) ||
      !String(databaseRestoreWorker.security_opt ?? []).includes(
        "no-new-privileges:true",
      ) ||
      JSON.stringify([...(databaseRestoreWorker.cap_drop ?? [])].sort()) !==
        JSON.stringify(["ALL"]) ||
      JSON.stringify([...(databaseRestoreWorker.cap_add ?? [])].sort()) !==
        JSON.stringify(["CHOWN", "KILL", "SETGID", "SETUID"])
    ) {
      throw new Error(
        "database-restore-worker privilege or tmpfs boundary drifted",
      );
    }
    const notificationDatabaseUrls = [
      notificationDeliveryEnvironment.NOTIFICATION_DELIVERY_DATABASE_URL,
      requireService("notification-delivery-migrate").environment
        ?.NOTIFICATION_DELIVERY_DATABASE_URL,
      maintenanceEnvironment.NOTIFICATION_DELIVERY_BACKUP_URL,
    ].map(value => new URL(value));
    for (const url of notificationDatabaseUrls) {
      if (
        url.protocol !== "postgresql:" ||
        url.hostname !== "127.0.0.1" ||
        url.port !== "55432" ||
        url.pathname !== "/winwidget_notification_delivery" ||
        url.searchParams.get("schema") !== "notification_delivery" ||
        url.searchParams.get("sslmode") !== "disable"
      ) {
        throw new Error(
          "Notification Delivery roles must use the dedicated loopback PostgreSQL database",
        );
      }
    }
    for (const forbidden of [
      "DATABASE_URL",
      "DATABASE_URL_PRODUCTION",
      "DATABASE_BACKUP_URL",
      "NOTIFICATION_DELIVERY_DATABASE_URL",
      "NOTIFICATION_DELIVERY_BACKUP_URL",
      "NOTIFICATION_DELIVERY_INTERNAL_TOKEN",
      "SMTP_LOGIN",
      "SMTP_PASSWORD",
      "TELEGRAM_INFO_BOT_TOKEN",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ]) {
      if (forbidden in campaignsEnvironment) {
        throw new Error(
          `campaigns-service must not receive ${forbidden}`,
        );
      }
    }
    if (
      new Set(notificationDatabaseUrls.map(url => url.username)).size !==
      notificationDatabaseUrls.length
    ) {
      throw new Error(
        "Notification Delivery runtime, migration and backup must use distinct roles",
      );
    }
    const campaignsDatabaseUrls = [
      campaignsEnvironment.CAMPAIGNS_DATABASE_URL,
      campaignsMigrationEnvironment.CAMPAIGNS_DATABASE_URL,
      maintenanceEnvironment.CAMPAIGNS_BACKUP_URL,
    ].map(value => new URL(value));
    for (const url of campaignsDatabaseUrls) {
      if (
        url.protocol !== "postgresql:" ||
        url.hostname !== "127.0.0.1" ||
        url.port !== "55433" ||
        url.pathname !== "/winwidget_campaigns" ||
        url.searchParams.get("schema") !== "campaigns" ||
        url.searchParams.get("sslmode") !== "disable"
      ) {
        throw new Error(
          "Campaigns roles must use the dedicated loopback PostgreSQL database",
        );
      }
    }
    if (
      new Set(campaignsDatabaseUrls.map(url => url.username)).size !==
      campaignsDatabaseUrls.length
    ) {
      throw new Error(
        "Campaigns runtime, migration and backup must use distinct roles",
      );
    }
    const reportingDatabaseUrls = [
      reportingEnvironment.REPORTING_DATABASE_URL,
      reportingMigrationEnvironment.REPORTING_DATABASE_URL,
      maintenanceEnvironment.REPORTING_BACKUP_URL,
    ].map(value => new URL(value));
    for (const url of reportingDatabaseUrls) {
      if (
        url.protocol !== "postgresql:" ||
        url.hostname !== "127.0.0.1" ||
        url.port !== "55435" ||
        url.pathname !== "/winwidget_reporting" ||
        url.searchParams.get("schema") !== "reporting" ||
        url.searchParams.get("sslmode") !== "disable"
      ) {
        throw new Error(
          "Reporting roles must use the dedicated loopback PostgreSQL database",
        );
      }
    }
    if (
      new Set(reportingDatabaseUrls.map(url => url.username)).size !==
      reportingDatabaseUrls.length
    ) {
      throw new Error(
        "Reporting runtime, migration and backup must use distinct roles",
      );
    }
    const widgetsDatabaseUrls = [
      widgetsEnvironment.WIDGETS_DATABASE_URL,
      widgetsMigrationEnvironment.WIDGETS_DATABASE_URL,
      maintenanceEnvironment.WIDGETS_BACKUP_URL,
    ].map(value => new URL(value));
    for (const url of widgetsDatabaseUrls) {
      if (
        url.protocol !== "postgresql:" ||
        url.hostname !== "127.0.0.1" ||
        url.port !== "55436" ||
        url.pathname !== "/winwidget_widgets" ||
        url.searchParams.get("schema") !== "widgets" ||
        url.searchParams.get("sslmode") !== "disable"
      ) {
        throw new Error(
          "Widgets roles must use the dedicated loopback PostgreSQL database",
        );
      }
    }
    if (
      new Set(widgetsDatabaseUrls.map(url => url.username)).size !==
      widgetsDatabaseUrls.length
    ) {
      throw new Error(
        "Widgets runtime, migration and backup must use distinct roles",
      );
    }
    const billingDatabaseUrls = [
      billingApiEnvironment.BILLING_DATABASE_URL,
      billingMigrationEnvironment.BILLING_DATABASE_URL,
      maintenanceEnvironment.BILLING_BACKUP_URL,
    ].map(value => new URL(value));
    for (const url of billingDatabaseUrls) {
      if (
        url.protocol !== "postgresql:" ||
        url.hostname !== "127.0.0.1" ||
        url.port !== "55437" ||
        url.pathname !== "/winwidget_billing" ||
        url.searchParams.get("schema") !== "billing" ||
        url.searchParams.get("sslmode") !== "disable"
      ) {
        throw new Error(
          "Billing roles must use the dedicated loopback PostgreSQL database",
        );
      }
    }
    if (
      new Set(billingDatabaseUrls.map(url => url.username)).size !==
      billingDatabaseUrls.length
    ) {
      throw new Error(
        "Billing runtime, migration and backup must use distinct roles",
      );
    }
    const identityDatabaseUrls = [
      identityApiEnvironment.IDENTITY_DATABASE_URL,
      identityMigrationEnvironment.IDENTITY_DATABASE_URL,
      maintenanceEnvironment.IDENTITY_BACKUP_URL,
    ].map(value => new URL(value));
    for (const url of identityDatabaseUrls) {
      if (
        url.protocol !== "postgresql:" ||
        url.hostname !== "127.0.0.1" ||
        url.port !== "55438" ||
        url.pathname !== "/winwidget_identity" ||
        url.searchParams.get("schema") !== "identity" ||
        url.searchParams.get("sslmode") !== "disable"
      ) {
        throw new Error(
          "Identity roles must use the dedicated loopback PostgreSQL database",
        );
      }
    }
    if (
      new Set(identityDatabaseUrls.map(url => url.username)).size !==
      identityDatabaseUrls.length
    ) {
      throw new Error(
        "Identity runtime, migration and backup must use distinct roles",
      );
    }
    for (const [, [, environment]] of billingRoles) {
      for (const forbidden of [
        "DATABASE_URL",
        "DATABASE_URL_PRODUCTION",
        "DATABASE_BACKUP_URL",
        "NOTIFICATION_DELIVERY_DATABASE_URL",
        "NOTIFICATION_DELIVERY_BACKUP_URL",
        "CAMPAIGNS_DATABASE_URL",
        "CAMPAIGNS_BACKUP_URL",
        "REPORTING_DATABASE_URL",
        "REPORTING_BACKUP_URL",
        "WIDGETS_DATABASE_URL",
        "WIDGETS_BACKUP_URL",
        "BILLING_BACKUP_URL",
        "BILLING_MIGRATION_DATABASE_URL",
        "BILLING_POSTGRES_ADMIN_USER",
        "BILLING_POSTGRES_ADMIN_PASSWORD_FILE",
        "SMTP_LOGIN",
        "SMTP_PASSWORD",
        "TELEGRAM_INFO_BOT_TOKEN",
        "S3_ACCESS_KEY_ID",
        "S3_SECRET_ACCESS_KEY",
      ]) {
        if (forbidden in environment) {
          throw new Error(`Billing runtime must not receive ${forbidden}`);
        }
      }
    }
    for (const [name, [, environment]] of identityRoles) {
      for (const forbidden of [
        "DATABASE_URL",
        "DATABASE_URL_PRODUCTION",
        "DATABASE_BACKUP_URL",
        "NOTIFICATION_DELIVERY_DATABASE_URL",
        "NOTIFICATION_DELIVERY_BACKUP_URL",
        "CAMPAIGNS_DATABASE_URL",
        "CAMPAIGNS_BACKUP_URL",
        "REPORTING_DATABASE_URL",
        "REPORTING_BACKUP_URL",
        "WIDGETS_DATABASE_URL",
        "WIDGETS_BACKUP_URL",
        "BILLING_DATABASE_URL",
        "BILLING_BACKUP_URL",
        "IDENTITY_BACKUP_URL",
        "IDENTITY_MIGRATION_DATABASE_URL",
        "IDENTITY_POSTGRES_ADMIN_USER",
        "IDENTITY_POSTGRES_ADMIN_PASSWORD_FILE",
      ]) {
        if (forbidden in environment) {
          throw new Error(
            `${name} must not receive ${forbidden}`,
          );
        }
      }
      if (
        ("RABBITMQ_URL" in environment) !==
        (name !== "identity-api")
      ) {
        throw new Error(`${name} RabbitMQ credential scope drifted`);
      }
      for (const avatarStorageKey of [
        "IDENTITY_AVATAR_S3_ENDPOINT",
        "IDENTITY_AVATAR_S3_REGION",
        "IDENTITY_AVATAR_S3_BUCKET",
        "IDENTITY_AVATAR_S3_ACCESS_KEY_ID",
        "IDENTITY_AVATAR_S3_SECRET_ACCESS_KEY",
        "IDENTITY_AVATAR_S3_PUBLIC_BASE_URL",
        "IDENTITY_AVATAR_S3_FORCE_PATH_STYLE",
      ]) {
        if ((avatarStorageKey in environment) !== (name === "identity-api")) {
          throw new Error(
            `${name} Identity avatar storage credential scope drifted`,
          );
        }
      }
    }
    for (const forbidden of [
      "DATABASE_URL",
      "DATABASE_URL_PRODUCTION",
      "DATABASE_BACKUP_URL",
      "NOTIFICATION_DELIVERY_DATABASE_URL",
      "NOTIFICATION_DELIVERY_BACKUP_URL",
      "CAMPAIGNS_DATABASE_URL",
      "CAMPAIGNS_BACKUP_URL",
      "SMTP_LOGIN",
      "SMTP_PASSWORD",
      "TELEGRAM_INFO_BOT_TOKEN",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ]) {
      if (forbidden in reportingEnvironment) {
        throw new Error(
          `reporting-service must not receive ${forbidden}`,
        );
      }
    }
    for (const forbidden of [
      "DATABASE_URL",
      "DATABASE_URL_PRODUCTION",
      "DATABASE_BACKUP_URL",
      "NOTIFICATION_DELIVERY_DATABASE_URL",
      "NOTIFICATION_DELIVERY_BACKUP_URL",
      "CAMPAIGNS_DATABASE_URL",
      "CAMPAIGNS_BACKUP_URL",
      "REPORTING_DATABASE_URL",
      "REPORTING_BACKUP_URL",
      "WIDGETS_BACKUP_URL",
      "WIDGETS_MIGRATION_DATABASE_URL",
      "WIDGETS_POSTGRES_ADMIN_USER",
      "WIDGETS_POSTGRES_ADMIN_PASSWORD_FILE",
      "SMTP_LOGIN",
      "SMTP_PASSWORD",
      "TELEGRAM_INFO_BOT_TOKEN",
    ]) {
      if (forbidden in widgetsEnvironment) {
        throw new Error(
          `widgets-service must not receive ${forbidden}`,
        );
      }
    }
    if ("RABBITMQ_URL" in (services.api.environment ?? {})) {
      throw new Error("api must not receive an AMQP URL");
    }
    for (const forbidden of [
      "S3_ENDPOINT",
      "S3_REGION",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_PUBLIC_BASE_URL",
      "S3_KEY_PREFIX",
      "S3_FORCE_PATH_STYLE",
    ]) {
      if (forbidden in apiEnvironment) {
        throw new Error(`Core api must not receive ${forbidden}`);
      }
    }
    if (!maintenance.healthcheck?.test) {
      throw new Error("maintenance-worker must define readiness healthcheck");
    }
    if (!notificationDelivery.healthcheck?.test) {
      throw new Error(
        "notification-delivery-worker must define readiness healthcheck",
      );
    }
    if (
      notificationDeliveryEnvironment.NOTIFICATION_DELIVERY_HEALTH_PORT !==
      "4401"
    ) {
      throw new Error(
        "notification-delivery-worker health port must be 4401",
      );
    }
    if (
      notificationDeliveryEnvironment.NOTIFICATION_DELIVERY_LISTEN_HOST !==
      "127.0.0.1"
    ) {
      throw new Error(
        "notification-delivery-worker must bind to loopback",
      );
    }
    if (
      notificationDeliveryEnvironment.NOTIFICATION_DELIVERY_PREFETCH !==
      "5"
    ) {
      throw new Error(
        "notification-delivery-worker prefetch must default to 5",
      );
    }
    const rabbitUsers = [
      services.rabbitmq.environment?.RABBITMQ_DEFAULT_USER,
      services.api.environment?.RABBITMQ_MONITOR_USER,
      new URL(services["outbox-publisher"].environment.RABBITMQ_URL).username,
      new URL(services["integration-worker"].environment.RABBITMQ_URL).username,
      new URL(services["maintenance-worker"].environment.RABBITMQ_URL).username,
      new URL(services["notification-delivery-worker"].environment.RABBITMQ_URL).username,
      new URL(services["campaigns-service"].environment.RABBITMQ_URL).username,
      new URL(services["reporting-service"].environment.RABBITMQ_URL).username,
      new URL(services["widgets-service"].environment.RABBITMQ_URL).username,
      new URL(services["billing-worker"].environment.RABBITMQ_URL).username,
      new URL(services["billing-outbox-publisher"].environment.RABBITMQ_URL).username,
      new URL(services["identity-worker"].environment.RABBITMQ_URL).username,
      new URL(services["identity-outbox-publisher"].environment.RABBITMQ_URL).username,
    ];
    if (
      services.rabbitmq.environment?.RABBITMQ_DEFAULT_VHOST !== "winwidget" ||
      services.api.environment?.RABBITMQ_VHOST !== "winwidget"
    ) {
      throw new Error("Production RabbitMQ vhost must be winwidget");
    }
    for (const name of [
      "outbox-publisher",
      "integration-worker",
      "maintenance-worker",
      "notification-delivery-worker",
      "campaigns-service",
      "reporting-service",
      "widgets-service",
      "billing-worker",
      "billing-outbox-publisher",
      "identity-worker",
      "identity-outbox-publisher",
    ]) {
      if (new URL(services[name].environment.RABBITMQ_URL).pathname !== "/winwidget") {
        throw new Error(`${name} must connect to the winwidget vhost`);
      }
    }
    if (
      rabbitUsers.some(value => !value) ||
      new Set(rabbitUsers).size !== rabbitUsers.length
    ) {
      throw new Error("RabbitMQ admin, monitor and service users must be distinct");
    }
    if (
      services["outbox-publisher"].environment.RABBITMQ_ASSERT_TOPOLOGY !== "true" ||
      services["integration-worker"].environment.RABBITMQ_ASSERT_TOPOLOGY !== "false" ||
      services["maintenance-worker"].environment.RABBITMQ_ASSERT_TOPOLOGY !== "false" ||
      services["notification-delivery-worker"].environment.RABBITMQ_ASSERT_TOPOLOGY !== "false" ||
      services["campaigns-service"].environment.RABBITMQ_ASSERT_TOPOLOGY !== "true" ||
      services["reporting-service"].environment.RABBITMQ_ASSERT_TOPOLOGY !== "true" ||
      services["widgets-service"].environment.RABBITMQ_ASSERT_TOPOLOGY !== "true" ||
      services["billing-worker"].environment.RABBITMQ_ASSERT_TOPOLOGY !== "true" ||
      services["billing-outbox-publisher"].environment.RABBITMQ_ASSERT_TOPOLOGY !== "false" ||
      services["identity-worker"].environment.RABBITMQ_ASSERT_TOPOLOGY !== "true" ||
      services["identity-outbox-publisher"].environment.RABBITMQ_ASSERT_TOPOLOGY !== "false"
    ) {
      throw new Error(
        "Only reviewed core and service worker topology owners may assert RabbitMQ topology",
      );
    }
    for (const name of [
      "outbox-publisher",
      "integration-worker",
      "maintenance-worker",
      "notification-delivery-worker",
      "campaigns-service",
      "reporting-service",
      "widgets-service",
      "billing-worker",
      "billing-outbox-publisher",
      "identity-worker",
      "identity-outbox-publisher",
    ]) {
      const environment = services[name].environment ?? {};
      for (const forbidden of [
        "JWT_SECRET",
        "JWT_ACCESS_PRIVATE_KEY_BASE64",
        "JWT_ACCESS_JWKS_BASE64",
        "JWT_ACCESS_ACTIVE_KID",
        "JWT_ISSUER",
        "JWT_AUDIENCE",
        "RABBITMQ_MONITOR_PASSWORD",
      ]) {
        if (forbidden in environment) {
          throw new Error(`${name} must not receive ${forbidden}`);
        }
      }
    }
    for (const forbidden of [
      "DATABASE_URL",
      "DATABASE_URL_PRODUCTION",
      "DATABASE_BACKUP_URL",
      "NOTIFICATION_DELIVERY_INTERNAL_URL",
      "NOTIFICATION_DELIVERY_INTERNAL_TIMEOUT_MS",
      "RABBITMQ_WORKER_PREFETCH",
      "RABBITMQ_ADMIN_PASSWORD",
      "RABBITMQ_MONITOR_PASSWORD",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "GOOGLE_CLIENT_SECRET",
      "GITHUB_CLIENT_SECRET",
      "YANDEX_CLIENT_SECRET",
      "VK_CLIENT_SECRET",
    ]) {
      if (forbidden in notificationDeliveryEnvironment) {
        throw new Error(
          `notification-delivery-worker must not receive ${forbidden}`,
        );
      }
    }
    for (const forbidden of [
      "SMTP_LOGIN",
      "SMTP_PASSWORD",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "GOOGLE_CLIENT_SECRET",
      "GITHUB_CLIENT_SECRET",
      "YANDEX_CLIENT_SECRET",
      "VK_CLIENT_SECRET",
      "RABBITMQ_ADMIN_PASSWORD",
    ]) {
      if (forbidden in maintenanceEnvironment) {
        throw new Error(
          `maintenance-worker must not receive ${forbidden}`,
        );
      }
    }
    const tmpfs = Array.isArray(maintenance.tmpfs)
      ? maintenance.tmpfs.map(value =>
          typeof value === "string" ? value : JSON.stringify(value),
        )
      : [];
    if (
      !tmpfs.some(
        value =>
          value.startsWith("/tmp") &&
          (value.includes("size=64m") ||
            value.includes("size=67108864") ||
            value.includes("\"size\":67108864")) &&
          (value.includes("mode=1777") ||
            value.includes("\"mode\":1777") ||
            value.includes("\"mode\":\"1777\"")),
      )
    ) {
      throw new Error("maintenance-worker must use bounded /tmp tmpfs");
    }
  '
