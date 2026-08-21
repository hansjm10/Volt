package main

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/volt-hq/Volt/packages/coding-agent/examples/remote/relay-credential-service/internal/pairingticket"
)

func main() {
	if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "usage: sanitize-pairing-ticket < ticket")
		os.Exit(2)
	}

	input, err := io.ReadAll(io.LimitReader(os.Stdin, pairingticket.MaxTicketSize+2))
	if err != nil {
		fmt.Fprintln(os.Stderr, "read pairing ticket: input error")
		os.Exit(1)
	}
	ticket := strings.TrimSpace(string(input))
	sanitized, err := pairingticket.SanitizeForApp(ticket)
	if err != nil {
		fmt.Fprintf(os.Stderr, "sanitize pairing ticket: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(sanitized)
}
