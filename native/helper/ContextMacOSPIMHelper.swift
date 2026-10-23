import Contacts
import AppKit
import Darwin
import EventKit
import Foundation

private let helperSchemaVersion = "macos-pim-helper-v1"

private enum HelperError: Error, CustomStringConvertible {
    case invalidArguments(String)
    case applicationActivationFailed
    case invalidOutput
    case outputLimit

    var description: String {
        switch self {
        case .invalidArguments(let message): return message
        case .applicationActivationFailed: return "The helper could not become a regular foreground application for authorization."
        case .invalidOutput: return "The helper produced a value that is not valid JSON."
        case .outputLimit: return "The helper output limit was reached before the scan completed."
        }
    }
}

private struct OutputLimits {
    static let defaultMaxRecords = 10_000
    static let defaultMaxBytes = 8 * 1024 * 1024
    static let maximumRecords = 100_000
    static let maximumBytes = 64 * 1024 * 1024

    let maxRecords: Int
    let maxBytes: Int

    init(maxRecords: Int = OutputLimits.defaultMaxRecords, maxBytes: Int = OutputLimits.defaultMaxBytes) throws {
        guard maxRecords > 0, maxRecords <= OutputLimits.maximumRecords else {
            throw HelperError.invalidArguments("--max-records must be between 1 and \(OutputLimits.maximumRecords).")
        }
        guard maxBytes > 0, maxBytes <= OutputLimits.maximumBytes else {
            throw HelperError.invalidArguments("--max-output-bytes must be between 1 and \(OutputLimits.maximumBytes).")
        }
        self.maxRecords = maxRecords
        self.maxBytes = maxBytes
    }
}

private final class JSONLWriter {
    private let limits: OutputLimits
    private(set) var recordCount = 0
    private(set) var byteCount = 0

    init(limits: OutputLimits) {
        self.limits = limits
    }

    func write(_ object: [String: Any]) throws {
        guard JSONSerialization.isValidJSONObject(object) else {
            throw HelperError.invalidOutput
        }
        let encoded = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let line = encoded + Data([0x0a])
        guard recordCount < limits.maxRecords, byteCount + line.count <= limits.maxBytes else {
            throw HelperError.outputLimit
        }
        FileHandle.standardOutput.write(line)
        recordCount += 1
        byteCount += line.count
    }

    func tryWriteError(_ error: Error) {
        try? write([
            "type": "error",
            "source": "helper",
            "code": "helper-failed",
            "message": error.localizedDescription,
            "schemaVersion": helperSchemaVersion,
        ])
    }
}

private enum AuthorizationState: String {
    case authorized
    case notDetermined = "not-determined"
    case denied
    case restricted
    case writeOnly = "write-only"
    case unknown
}

private struct CalendarCommandOptions {
    let from: Date
    let to: Date
    let limits: OutputLimits
}

private enum Command {
    case status
    case authorize(target: String)
    case calendar(CalendarCommandOptions)
    case contacts(OutputLimits)
}

@main
private struct ContextMacOSPIMHelper {
    @MainActor
    static func main() {
        do {
            let command = try parseCommand(Array(CommandLine.arguments.dropFirst()))
            let limits: OutputLimits
            switch command {
            case .status:
                limits = try OutputLimits()
            case .authorize:
                limits = try OutputLimits(maxRecords: 16, maxBytes: 64 * 1024)
            case .calendar(let options):
                limits = options.limits
            case .contacts(let commandLimits):
                limits = commandLimits
            }
            let writer = JSONLWriter(limits: limits)

            do {
                switch command {
                case .authorize(let target):
                    Darwin.exit(try runAuthorizationApplication(target: target, writer: writer))
                case .status:
                    try writeStatus(to: writer)
                    Darwin.exit(0)
                case .calendar(let options):
                    Darwin.exit(try runCalendar(options: options, writer: writer))
                case .contacts:
                    Darwin.exit(try runContacts(writer: writer))
                }
            } catch {
                writer.tryWriteError(error)
                FileHandle.standardError.write(Data("\(error)\n".utf8))
                Darwin.exit(2)
            }
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            Darwin.exit(2)
        }
    }

    @MainActor
    private static func runAuthorizationApplication(target: String, writer: JSONLWriter) throws -> Int32 {
        let application = NSApplication.shared
        guard application.setActivationPolicy(.regular) else {
            throw HelperError.applicationActivationFailed
        }
        application.finishLaunching()
        application.activate(ignoringOtherApps: true)

        var exitCode: Int32?
        Task { @MainActor in
            exitCode = await authorize(target: target, writer: writer)
            application.stop(nil)
            application.postEvent(
                NSEvent.otherEvent(
                    with: .applicationDefined,
                    location: .zero,
                    modifierFlags: [],
                    timestamp: 0,
                    windowNumber: 0,
                    context: nil,
                    subtype: 0,
                    data1: 0,
                    data2: 0
                )!,
                atStart: false
            )
        }
        repeat {
            application.run()
        } while exitCode == nil
        return exitCode!
    }

    private static func parseCommand(_ arguments: [String]) throws -> Command {
        guard let name = arguments.first else {
            throw HelperError.invalidArguments("Usage: status | authorize <calendar|contacts|all> | calendar --from ISO --to ISO | contacts")
        }
        switch name {
        case "status":
            guard arguments.count == 1 else {
                throw HelperError.invalidArguments("status does not accept arguments.")
            }
            return .status
        case "authorize":
            guard arguments.count == 2, ["calendar", "contacts", "all"].contains(arguments[1]) else {
                throw HelperError.invalidArguments("authorize requires one target: calendar, contacts, or all.")
            }
            return .authorize(target: arguments[1])
        case "calendar":
            let values = try parseOptions(Array(arguments.dropFirst()))
            guard let fromValue = values["from"], let toValue = values["to"] else {
                throw HelperError.invalidArguments("calendar requires --from and --to ISO-8601 values.")
            }
            let from = try parseISO8601(fromValue, label: "--from")
            let to = try parseISO8601(toValue, label: "--to")
            guard from < to else {
                throw HelperError.invalidArguments("calendar requires --from to be earlier than --to.")
            }
            return .calendar(CalendarCommandOptions(
                from: from,
                to: to,
                limits: try parseLimits(values),
            ))
        case "contacts":
            return .contacts(try parseLimits(try parseOptions(Array(arguments.dropFirst()))))
        default:
            throw HelperError.invalidArguments("Unknown command: \(name)")
        }
    }

    private static func parseOptions(_ arguments: [String]) throws -> [String: String] {
        var values: [String: String] = [:]
        var index = 0
        while index < arguments.count {
            let flag = arguments[index]
            guard flag.hasPrefix("--"), index + 1 < arguments.count else {
                throw HelperError.invalidArguments("Expected a value after \(flag).")
            }
            let key = String(flag.dropFirst(2))
            guard !key.isEmpty, values[key] == nil else {
                throw HelperError.invalidArguments("Duplicate or invalid option: \(flag)")
            }
            values[key] = arguments[index + 1]
            index += 2
        }
        return values
    }

    private static func parseLimits(_ values: [String: String]) throws -> OutputLimits {
        let maxRecords = try parsePositiveInt(values["max-records"], defaultValue: OutputLimits.defaultMaxRecords, label: "--max-records")
        let maxBytes = try parsePositiveInt(values["max-output-bytes"], defaultValue: OutputLimits.defaultMaxBytes, label: "--max-output-bytes")
        let recognized: Set<String> = ["from", "to", "max-records", "max-output-bytes"]
        if let unknown = values.keys.first(where: { !recognized.contains($0) }) {
            throw HelperError.invalidArguments("Unknown option: --\(unknown)")
        }
        return try OutputLimits(maxRecords: maxRecords, maxBytes: maxBytes)
    }

    private static func parsePositiveInt(_ value: String?, defaultValue: Int, label: String) throws -> Int {
        guard let value else { return defaultValue }
        guard let parsed = Int(value), parsed > 0 else {
            throw HelperError.invalidArguments("\(label) must be a positive integer.")
        }
        return parsed
    }

    private static func parseISO8601(_ value: String, label: String) throws -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.date(from: value) { return date }
        throw HelperError.invalidArguments("\(label) must be an ISO-8601 date-time.")
    }

    private static func writeStatus(to writer: JSONLWriter) throws {
        try writer.write([
            "type": "status",
            "calendarAuthorization": calendarAuthorizationState().rawValue,
            "contactsAuthorization": contactsAuthorizationState().rawValue,
            "schemaVersion": helperSchemaVersion,
        ])
    }

    @MainActor
    private static func authorize(target: String, writer: JSONLWriter) async -> Int32 {
        var exitCode: Int32 = 0
        if target == "calendar" || target == "all" {
            let store = EKEventStore()
            let before = calendarAuthorizationState()
            if before == .authorized {
                try? writer.write([
                    "type": "authorization",
                    "source": "calendar",
                    "state": before.rawValue,
                    "prompted": false,
                    "granted": true,
                ])
            } else if before == .denied || before == .restricted || before == .writeOnly {
                var output: [String: Any] = [
                    "type": "authorization",
                    "source": "calendar",
                    "state": before.rawValue,
                    "prompted": false,
                    "granted": false,
                ]
                addManualAction(source: "calendar", to: &output)
                try? writer.write(output)
                exitCode = 3
            } else {
                let result = await requestCalendarAccess(store)
                let after = calendarAuthorizationState()
                var output: [String: Any] = [
                    "type": "authorization",
                    "source": "calendar",
                    "state": after.rawValue,
                    "prompted": true,
                    "granted": result.granted,
                ]
                put(result.error, into: &output, key: "error")
                if !result.granted { addManualAction(source: "calendar", to: &output) }
                try? writer.write(output)
                if !result.granted { exitCode = 3 }
            }
        }
        if target == "contacts" || target == "all" {
            let store = CNContactStore()
            let before = contactsAuthorizationState()
            if before == .authorized {
                try? writer.write([
                    "type": "authorization",
                    "source": "contacts",
                    "state": before.rawValue,
                    "prompted": false,
                    "granted": true,
                ])
            } else if before == .denied || before == .restricted {
                var output: [String: Any] = [
                    "type": "authorization",
                    "source": "contacts",
                    "state": before.rawValue,
                    "prompted": false,
                    "granted": false,
                ]
                addManualAction(source: "contacts", to: &output)
                try? writer.write(output)
                exitCode = 3
            } else {
                let result = await requestContactsAccess(store)
                let after = contactsAuthorizationState()
                var output: [String: Any] = [
                    "type": "authorization",
                    "source": "contacts",
                    "state": after.rawValue,
                    "prompted": true,
                    "granted": result.granted,
                ]
                put(result.error, into: &output, key: "error")
                if !result.granted { addManualAction(source: "contacts", to: &output) }
                try? writer.write(output)
                if !result.granted { exitCode = 3 }
            }
        }
        return exitCode
    }

    @MainActor
    private static func requestCalendarAccess(_ store: EKEventStore) async -> (granted: Bool, error: String?) {
        return await withCheckedContinuation { continuation in
            store.requestFullAccessToEvents { granted, error in
                continuation.resume(returning: (granted, error?.localizedDescription))
            }
        }
    }

    @MainActor
    private static func requestContactsAccess(_ store: CNContactStore) async -> (granted: Bool, error: String?) {
        await withCheckedContinuation { continuation in
            store.requestAccess(for: .contacts) { granted, error in
                continuation.resume(returning: (granted, error?.localizedDescription))
            }
        }
    }

    private static func runCalendar(options: CalendarCommandOptions, writer: JSONLWriter) throws -> Int32 {
        let authorization = calendarAuthorizationState()
        guard authorization == .authorized else {
            try writeAuthorizationError(source: "calendar", state: authorization, writer: writer)
            try writer.write([
                "type": "scan_finished",
                "source": "calendar",
                "complete": false,
                "scanned": 0,
            ])
            return 3
        }

        let store = EKEventStore()
        let calendars = store.calendars(for: .event)
        let predicate = store.predicateForEvents(withStart: options.from, end: options.to, calendars: calendars)
        let events = store.events(matching: predicate).sorted {
            if $0.startDate != $1.startDate { return $0.startDate < $1.startDate }
            return ($0.eventIdentifier ?? $0.calendarItemExternalIdentifier ?? "") < ($1.eventIdentifier ?? $1.calendarItemExternalIdentifier ?? "")
        }
        var complete = true
        var scanned = 0
        for event in events {
            guard event.endDate > options.from, event.startDate < options.to else { continue }
            guard event.endDate >= event.startDate else {
                try writer.write([
                    "type": "warning",
                    "source": "calendar",
                    "message": "Skipped an event whose end precedes its start.",
                ])
                complete = false
                continue
            }
            guard let identifier = nonEmpty(event.eventIdentifier) ?? nonEmpty(event.calendarItemExternalIdentifier) else {
                try writer.write([
                    "type": "warning",
                    "source": "calendar",
                    "message": "Skipped an event without a stable EventKit identifier.",
                ])
                complete = false
                continue
            }
            try writer.write(calendarEventPayload(event: event, identifier: identifier))
            scanned += 1
        }
        try writer.write([
            "type": "scan_finished",
            "source": "calendar",
            "complete": complete,
            "scanned": scanned,
            "window": [
                "from": iso8601(options.from),
                "to": iso8601(options.to),
            ],
        ])
        return complete ? 0 : 4
    }

    private static func runContacts(writer: JSONLWriter) throws -> Int32 {
        let authorization = contactsAuthorizationState()
        guard authorization == .authorized else {
            try writeAuthorizationError(source: "contacts", state: authorization, writer: writer)
            try writer.write([
                "type": "scan_finished",
                "source": "contacts",
                "complete": false,
                "scanned": 0,
            ])
            return 3
        }

        let store = CNContactStore()
        let keysToFetch: [CNKeyDescriptor] = [
            CNContactIdentifierKey as CNKeyDescriptor,
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactMiddleNameKey as CNKeyDescriptor,
            CNContactNamePrefixKey as CNKeyDescriptor,
            CNContactNameSuffixKey as CNKeyDescriptor,
            CNContactNicknameKey as CNKeyDescriptor,
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactDepartmentNameKey as CNKeyDescriptor,
            CNContactJobTitleKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor,
            CNContactPostalAddressesKey as CNKeyDescriptor,
            CNContactUrlAddressesKey as CNKeyDescriptor,
            CNContactDatesKey as CNKeyDescriptor,
            CNContactBirthdayKey as CNKeyDescriptor,
        ]

        var complete = true
        var scanned = 0
        var seenIdentifiers: Set<String> = []
        do {
            let containers = try store.containers(matching: nil)
            for container in containers.sorted(by: { $0.identifier < $1.identifier }) {
                do {
                    let predicate = CNContact.predicateForContactsInContainer(withIdentifier: container.identifier)
                    let contacts = try store.unifiedContacts(matching: predicate, keysToFetch: keysToFetch)
                    for contact in contacts.sorted(by: { $0.identifier < $1.identifier }) {
                        guard seenIdentifiers.insert(contact.identifier).inserted else { continue }
                        try writer.write(contactPayload(contact))
                        scanned += 1
                    }
                } catch {
                    try writer.write([
                        "type": "warning",
                        "source": "contacts",
                        "message": "Could not read contacts from container \(container.identifier): \(error.localizedDescription)",
                    ])
                    complete = false
                }
            }
        } catch {
            try writer.write([
                "type": "error",
                "source": "contacts",
                "code": "contact-scan-failed",
                "message": error.localizedDescription,
            ])
            complete = false
        }

        try writer.write([
            "type": "scan_finished",
            "source": "contacts",
            "complete": complete,
            "scanned": scanned,
        ])
        return complete ? 0 : 4
    }

    private static func writeAuthorizationError(source: String, state: AuthorizationState, writer: JSONLWriter) throws {
        let code = state == .denied || state == .restricted || state == .writeOnly
            ? "authorization-denied"
            : "authorization-required"
        try writer.write([
            "type": "error",
            "source": source,
            "code": code,
            "authorization": state.rawValue,
            "message": "Read access is not authorized. Run the explicit authorize command before scanning.",
        ])
    }

    private static func addManualAction(source: String, to output: inout [String: Any]) {
        output["manualActionRequired"] = true
        output["manualAction"] = source == "contacts"
            ? "System Settings → Privacy & Security → Contacts → Context macOS PIM Helper"
            : "System Settings → Privacy & Security → Calendars → Context macOS PIM Helper"
    }

    private static func calendarAuthorizationState() -> AuthorizationState {
        let status = EKEventStore.authorizationStatus(for: .event)
        if #available(macOS 14.0, *) {
            switch status {
            case .fullAccess:
                return .authorized
            case .writeOnly:
                return .writeOnly
            case .notDetermined:
                return .notDetermined
            case .denied:
                return .denied
            case .restricted:
                return .restricted
            @unknown default:
                return .unknown
            }
        }
        switch status {
        case .fullAccess:
            return .authorized
        case .writeOnly:
            return .writeOnly
        case .authorized:
            return .authorized
        case .notDetermined:
            return .notDetermined
        case .denied:
            return .denied
        case .restricted:
            return .restricted
        @unknown default:
            return .unknown
        }
    }

    private static func contactsAuthorizationState() -> AuthorizationState {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized:
            return .authorized
        case .notDetermined:
            return .notDetermined
        case .denied:
            return .denied
        case .restricted:
            return .restricted
        @unknown default:
            return .unknown
        }
    }

    private static func calendarEventPayload(event: EKEvent, identifier: String) -> [String: Any] {
        var payload: [String: Any] = [
            "type": "calendar_event",
            "id": identifier,
            "calendar": calendarPayload(event.calendar),
            "title": event.title ?? "",
            "allDay": event.isAllDay,
            "start": iso8601(event.startDate),
            "end": iso8601(event.endDate),
            "attendees": event.attendees?.map(participantPayload) ?? [],
            "recurrence": event.recurrenceRules?.map { $0.description } ?? [],
            "status": eventStatus(event.status),
        ]
        put(nonEmpty(event.notes), into: &payload, key: "notes")
        put(nonEmpty(event.location), into: &payload, key: "location")
        put(event.url?.absoluteString, into: &payload, key: "url")
        put(event.organizer.map(participantPayload), into: &payload, key: "organizer")
        put(event.timeZone?.identifier, into: &payload, key: "timeZone")
        put(nonEmpty(event.calendarItemExternalIdentifier), into: &payload, key: "calendarItemExternalIdentifier")
        if let occurrenceDate = event.occurrenceDate {
            payload["occurrenceDate"] = iso8601(occurrenceDate)
        }
        return payload
    }

    private static func calendarPayload(_ calendar: EKCalendar) -> [String: Any] {
        var payload: [String: Any] = [
            "identifier": calendar.calendarIdentifier,
            "title": calendar.title,
            "type": calendarTypeWireValue(calendar.type),
        ]
        put(calendar.source?.sourceIdentifier, into: &payload, key: "sourceIdentifier")
        put(calendar.source?.title, into: &payload, key: "sourceTitle")
        return payload
    }

    private static func calendarTypeWireValue(_ type: EKCalendarType) -> String {
        switch type {
        case .local: return "local"
        case .calDAV: return "caldav"
        case .exchange: return "exchange"
        case .subscription: return "subscription"
        case .birthday: return "birthday"
        @unknown default: return "unknown"
        }
    }

    private static func participantPayload(_ participant: EKParticipant) -> [String: Any] {
        var payload: [String: Any] = [
            "url": participant.url.absoluteString,
            "role": String(describing: participant.participantRole),
            "status": String(describing: participant.participantStatus),
            "type": String(describing: participant.participantType),
            "currentUser": participant.isCurrentUser,
        ]
        put(nonEmpty(participant.name), into: &payload, key: "name")
        return payload
    }

    private static func eventStatus(_ status: EKEventStatus) -> String {
        let value = String(describing: status).lowercased()
        if value.contains("cancel") { return "canceled" }
        if value.contains("tentative") { return "tentative" }
        if value.contains("confirmed") { return "confirmed" }
        return "none"
    }

    private static func contactPayload(_ contact: CNContact) -> [String: Any] {
        var payload: [String: Any] = [
            "type": "contact",
            "identifier": contact.identifier,
            "names": compact([
                "given": contact.givenName,
                "family": contact.familyName,
                "middle": contact.middleName,
                "prefix": contact.namePrefix,
                "suffix": contact.nameSuffix,
                "nickname": contact.nickname,
            ]),
            "organization": compact([
                "name": contact.organizationName,
                "department": contact.departmentName,
                "jobTitle": contact.jobTitle,
            ]),
            "phones": contact.phoneNumbers.map { labeledStringPayload(label: $0.label, value: $0.value.stringValue) },
            "emails": contact.emailAddresses.map { labeledStringPayload(label: $0.label, value: String($0.value)) },
            "addresses": contact.postalAddresses.map(postalAddressPayload),
            "urls": contact.urlAddresses.map { labeledStringPayload(label: $0.label, value: String($0.value)) },
            "dates": contact.dates.map { labeledDatePayload(label: $0.label, value: $0.value) },
        ]
        if let birthday = contact.birthday {
            payload["birthday"] = dateComponentsPayload(birthday)
        }
        // The public Contacts framework on current macOS SDKs does not expose
        // a modification-date key. Keep the field optional in the JSON
        // contract so a public SDK that provides it can add it later without
        // changing the connector identity or reconciliation rules.
        return payload
    }

    private static func labeledStringPayload(label: String?, value: String) -> [String: Any] {
        var payload: [String: Any] = ["value": value]
        put(label, into: &payload, key: "label")
        return payload
    }

    private static func postalAddressPayload(_ value: CNLabeledValue<CNPostalAddress>) -> [String: Any] {
        let address = value.value
        var payload: [String: Any] = compact([
            "street": address.street,
            "city": address.city,
            "state": address.state,
            "postalCode": address.postalCode,
            "country": address.country,
            "isoCountryCode": address.isoCountryCode,
            "subLocality": address.subLocality,
            "subAdministrativeArea": address.subAdministrativeArea,
        ])
        put(value.label, into: &payload, key: "label")
        return payload
    }

    private static func labeledDatePayload(label: String?, value: NSDateComponents) -> [String: Any] {
        var payload = dateComponentsPayload(value)
        put(label, into: &payload, key: "label")
        return payload
    }

    private static func dateComponentsPayload(_ value: NSDateComponents) -> [String: Any] {
        var payload: [String: Any] = [:]
        put(value.era, into: &payload, key: "era")
        put(value.year, into: &payload, key: "year")
        put(value.month, into: &payload, key: "month")
        put(value.day, into: &payload, key: "day")
        put(value.hour, into: &payload, key: "hour")
        put(value.minute, into: &payload, key: "minute")
        put(value.second, into: &payload, key: "second")
        put(value.calendar.map { String(describing: $0.identifier) }, into: &payload, key: "calendar")
        put(value.timeZone?.identifier, into: &payload, key: "timeZone")
        return payload
    }

    private static func dateComponentsPayload(_ value: DateComponents) -> [String: Any] {
        var payload: [String: Any] = [:]
        put(value.era, into: &payload, key: "era")
        put(value.year, into: &payload, key: "year")
        put(value.month, into: &payload, key: "month")
        put(value.day, into: &payload, key: "day")
        put(value.hour, into: &payload, key: "hour")
        put(value.minute, into: &payload, key: "minute")
        put(value.second, into: &payload, key: "second")
        put(value.calendar.map { String(describing: $0.identifier) }, into: &payload, key: "calendar")
        put(value.timeZone?.identifier, into: &payload, key: "timeZone")
        return payload
    }

    private static func compact(_ values: [String: String]) -> [String: Any] {
        values.reduce(into: [String: Any]()) { output, pair in
            if let value = nonEmpty(pair.value) { output[pair.key] = value }
        }
    }

    private static func put(_ value: Any?, into payload: inout [String: Any], key: String) {
        guard let value else { return }
        if let string = value as? String, string.isEmpty { return }
        payload[key] = value
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    private static func iso8601(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
